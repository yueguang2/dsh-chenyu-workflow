/** Prepare the active ComfyUI graph against the instance's current node schema. */
import {
  ComfyError, comfyComboOptions, comfyInputSpecs, convertWorkflowToPrompt, isComfyLink, promptFromConversion,
} from './comfy.mjs'
import { DEFAULT_WORKFLOWS } from './defaults.mjs'

const OUTPUT_NODE = /^(?:Save(?:Image|Animated|Audio|Video)|VHS_VideoCombine|Preview(?:Image|Any))/i
const H3_NODE = /^(?:MiniMaxH3(?:ReferenceToVideo|ImageToVideo|TextToVideo|FirstLastFrameToVideo)|MinimaxHailuo03(?:Reference|TextToVideo|FirstLastFrame)Node)$/i
const MOSS_FILE = /(?:^|[\\/_. -])(?:moss|kook)(?:[\\/_. -]|$)/i
const LOADER = /^(?:LoadImage(?:Mask)?|(?:VHS_)?LoadVideo(?:FFmpeg)?|LoadAudio)$/i
const MEDIA = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO' }
const ROLE_NAMES = {
  prompt: /^(?:prompt|prompt_text|text_prompt|positive_prompt|positive|conditioning)$/i,
  seed: /^(?:seed|noise_seed|random_seed)$/i,
  megapixels: /^(?:megapixels|mega_pixels|resolution_mp|mp)$/i,
  aspect_ratio: /^(?:aspect_ratio|aspectratio|aspect|ratio)$/i,
  duration: /^(?:duration|duration_seconds|video_duration|seconds|length_seconds)$/i,
}
const ROLE_TITLES = {
  prompt: /^(?:prompt|positive(?: prompt)?|提示词|正向提示词)$/i,
  seed: /^(?:seed|random seed|随机种子|种子)$/i,
  megapixels: /^(?:megapixels|mega pixels|总像素|百万像素)$/i,
  aspect_ratio: /^(?:aspect ratio|宽高比|画面比例|尺寸比例)$/i,
  duration: /^(?:duration(?: in seconds)?|video duration|seconds|时长|视频时长)$/i,
}
const FIELD_NAMES = ['prompt', 'seed', 'megapixels', 'aspect_ratio', 'duration']

function loaderKind(node) {
  const type = node?.class_type || node?.type || ''
  return LOADER.test(type) ? Object.keys(MEDIA).find((kind) => type.toLowerCase().includes(kind)) : undefined
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function graph(prompt, objectInfo) {
  const outputs = Object.keys(prompt).filter((id) => {
    const type = prompt[id]?.class_type
    return objectInfo[type]?.output_node ?? OUTPUT_NODE.test(type)
  })
  function ancestors(roots) {
    const seen = new Set()
    const stack = [...roots]
    while (stack.length) {
      const id = String(stack.pop())
      if (seen.has(id)) continue
      seen.add(id)
      for (const value of Object.values(record(prompt[id]?.inputs))) {
        if (isComfyLink(value)) stack.push(value[0])
      }
    }
    return seen
  }
  return { outputs, ancestors, active: ancestors(outputs) }
}

function mediaRole(input) {
  const leaf = input.split('.').at(-1).toLowerCase()
  const numbered = /^(?:ref(?:erence)?_?)?(images?|videos?|audios?)(?:_?(\d+))?$/.exec(leaf)
  if (numbered) return { kind: numbered[1].replace(/s$/, ''), index: numbered[2] == null ? null : Number(numbered[2]) }
  const frame = /^(first|last)_?frame(?:_?image)?$/.exec(leaf)
  if (frame) return { kind: 'image', index: frame[1] === 'first' ? 1 : 2 }
  return null
}

function families(prompt, objectInfo, active) {
  const found = new Set()
  for (const id of active) {
    const node = prompt[id]
    if (!node || !objectInfo[node.class_type]) continue
    if (H3_NODE.test(node.class_type)) found.add('video')
    if (/moss/i.test(node.class_type) || Object.entries(record(node.inputs)).some(([key, value]) =>
      /^(?:ckpt_name|unet_name|model_name|diffusion_model|model|model_path)$/.test(key)
      && typeof value === 'string' && MOSS_FILE.test(value))) found.add('image')
  }
  return found
}

function oldDefaultType(job) {
  if (job.workflow_file || job.workflow_json) return ''
  return Object.values(DEFAULT_WORKFLOWS).find((entry) => entry.label === job.workflow_label
    && (entry.workflow_name === job.workflow_name || (entry.prompt_node === job.prompt_node && entry.prompt_input === job.prompt_input)))?.type || ''
}

export function indicatedDefaultType(job) {
  return Object.hasOwn(job, 'workflow_default_type') ? job.workflow_default_type : oldDefaultType(job)
}

function foundFamily(workflow, objectInfo) {
  const prompt = promptFromConversion(convertWorkflowToPrompt(workflow, objectInfo, { preserveUnknown: true }))
  return families(prompt, objectInfo, graph(prompt, objectInfo).active)
}

export async function resolveInstanceWorkflow(job, { read, list, objectInfo, config = {} }) {
  const name = job.workflow_name
  try {
    return { workflow: await read(name), name, warnings: [] }
  } catch (error) {
    const type = indicatedDefaultType(job)
    if (error.status !== 404 || !type || job.workflow_discovery === false || config.workflowDiscovery === false) throw error
    const names = [...new Set(await list())].filter((name) => /\.json$/i.test(name) && name !== job.workflow_name)
    const matches = []
    for (const candidate of names) {
      let workflow
      try {
        workflow = await read(candidate)
      } catch (candidateError) {
        if (candidateError.status === 404) continue
        throw candidateError
      }
      // Userdata can contain unrelated JSON under workflows. A JSON object
      // that cannot be converted to an executable graph is not a candidate.
      let family
      try { family = foundFamily(workflow, objectInfo) } catch (candidateError) {
        if (candidateError instanceof ComfyError) continue
        throw candidateError
      }
      if (family.size === 1 && family.has(type)) matches.push({ workflow, name: candidate })
    }
    if (matches.length !== 1) {
      const detail = matches.length ? `发现多个同系列工作流：${matches.map(({ name }) => name).join('、')}` : '没有找到可用的同系列工作流'
      throw new ComfyError(`默认工作流 ${name} 已不存在。${detail}；请明确指定 workflow_name。`)
    }
    return { ...matches[0], warnings: [`默认工作流 ${name} 已不存在，使用当前实例唯一的同系列工作流 ${matches[0].name}。`] }
  }
}

function fieldType(role, spec) {
  if (role === 'prompt') return spec?.[0] === 'STRING'
  if (role === 'aspect_ratio') return spec?.[0] === 'STRING' || comfyComboOptions(spec) !== null
  return ['INT', 'FLOAT'].includes(spec?.[0])
}

function nodeSpecs(prompt, objectInfo, id) {
  const node = prompt[id]
  return comfyInputSpecs(objectInfo[node?.class_type], node?.inputs)
}

function bindingCandidates(prompt, objectInfo, active, role, job, family) {
  const targets = new Map()
  function add(id, input, rank) {
    const spec = nodeSpecs(prompt, objectInfo, id).get(input)?.spec
    const value = prompt[id]?.inputs?.[input]
    if (!active.has(id) || !fieldType(role, spec) || isComfyLink(value)) return
    if (job.prompt_input && role === 'prompt' && job.prompt_input !== input) return
    const key = `${id}.${input}`
    if (rank > (targets.get(key)?.rank ?? -1)) targets.set(key, { node_id: id, input, rank, spec })
  }
  if (role === 'prompt' && job.prompt_node) {
    const id = String(job.prompt_node)
    for (const [key] of nodeSpecs(prompt, objectInfo, id)) add(id, key, 1)
    return [...targets.values()]
  }
  for (const id of active) {
    const node = prompt[id]
    if (!node) continue
    const type = node.class_type
    const title = node._meta?.title || ''
    if (role === 'prompt' && /negative|负面|反向|负向/i.test(title)) continue
    for (const [input] of nodeSpecs(prompt, objectInfo, id)) {
      const leaf = input.split('.').at(-1)
      const value = node.inputs?.[input]
      const semantic = ROLE_NAMES[role].test(leaf)
        || (role === 'prompt' && H3_NODE.test(type) && leaf === 'text')
      if (semantic && isComfyLink(value)) {
        const source = String(value[0])
        // A primitive (or text encoder) linked to a semantic port may own the widget.
        for (const [key] of nodeSpecs(prompt, objectInfo, source)) {
          if (/^(?:value|text|prompt|prompt_text|seed|noise_seed|duration|seconds|megapixels|aspect_ratio|ratio)$/i.test(key)
              || ROLE_NAMES[role].test(key)) add(source, key, H3_NODE.test(type) ? 5 : 4)
        }
      } else if (semantic) {
        add(id, input, H3_NODE.test(type) ? 5 : 3)
      } else if (ROLE_TITLES[role].test(title)) {
        add(id, input, 3)
      } else if (role === 'prompt' && /^(?:text|value)$/i.test(leaf)
          && /^(?:Text|PrimitiveString(?:Multiline)?|CLIPTextEncode.*)$/i.test(type)) {
        add(id, input, 1)
      }
    }
  }
  if (family && role === 'duration' && ![...targets.values()].length) {
    const legacy = DEFAULT_WORKFLOWS[family]
    const node = prompt[legacy.duration_node]
    // A former coordinate alone proves nothing. Require the same typed, linked control.
    if (node && /^(?:PrimitiveInt|PrimitiveFloat)$/i.test(node.class_type)
        && ROLE_TITLES.duration.test(node._meta?.title || '')) add(legacy.duration_node, legacy.duration_input, 1)
  }
  return [...targets.values()].sort((a, b) => b.rank - a.rank)
}

function chooseBinding(prompt, objectInfo, active, role, job, family) {
  const candidates = bindingCandidates(prompt, objectInfo, active, role, job, family)
  const first = candidates[0]
  if (!first || candidates[1]?.rank === first.rank) {
    const options = candidates.filter((item) => item.rank === first?.rank).map(({ node_id, input }) => `${node_id}.${input}`)
    const manual = role === 'prompt' ? 'prompt_node/prompt_input 或 overrides' : 'overrides'
    throw new ComfyError(`${role} ${options.length ? `有多个候选参数：${options.join('、')}` : '没有找到可绑定的参数'}；请使用 ${manual} 精确指定。`)
  }
  return first
}

function validateLiteral(value, spec, location) {
  const type = spec[0]
  const options = comfyComboOptions(spec)
  if (options && !options.includes(value)) {
    const stringOptions = options.filter((option) => typeof option === 'string')
    const path = typeof value === 'string' ? value.replaceAll('\\', '/') : ''
    const matches = stringOptions.filter((option) => {
      if (path && option.replaceAll('\\', '/').endsWith(`/${path}`)) return true
      const ratio = /^\s*(\d+)\s*:\s*(\d+)/.exec(path)
      const optionRatio = /^\s*(\d+)\s*:\s*(\d+)/.exec(option)
      return ratio && optionRatio && ratio[1] === optionRatio[1] && ratio[2] === optionRatio[2]
    })
    if (matches.length === 1) return matches[0]
    throw new ComfyError(`${location} 的值 ${JSON.stringify(value)} 不在当前节点的可选范围内${matches.length > 1 ? '（存在多个匹配项）' : ''}。`)
  }
  if (['INT', 'FLOAT'].includes(type)) {
    const { min = -Infinity, max = Infinity } = spec[1] || {}
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'INT' && !Number.isInteger(value)) || value < min || value > max) {
      throw new ComfyError(`${location} 需要${type === 'INT' ? '整数' : '数字'}${Number.isFinite(min) && Number.isFinite(max) ? `（${min}–${max}）` : ''}。`)
    }
  } else if ((type === 'STRING' && typeof value !== 'string') || (type === 'BOOLEAN' && typeof value !== 'boolean')) {
    throw new ComfyError(`${location} 需要 ${type} 类型。`)
  }
  return value
}

function fileBinding(prompt, objectInfo, id, source) {
  const node = prompt[id]
  const input = typeof source === 'object' && source?.input ? source.input : loaderKind(node)
  const path = typeof source === 'string' ? source : source?.path
  const spec = nodeSpecs(prompt, objectInfo, id).get(input)?.spec
  if (!spec || !(spec[0] === 'STRING' || comfyComboOptions(spec) !== null)) {
    throw new ComfyError(`files.${id} 没有可上传的文件参数；请检查节点并指定 {path, input}。`)
  }
  if (typeof path !== 'string' || !path) throw new ComfyError(`files.${id} 缺少本地文件路径。`)
  return { input, path }
}

function referenceTargets(prompt, objectInfo, active, ancestors, kind, family) {
  const targets = []
  for (const id of active) {
    const node = prompt[id]
    if (family === 'video' && !H3_NODE.test(node?.class_type || '')) continue
    if (!node) continue
    const specs = nodeSpecs(prompt, objectInfo, id)
    for (const [input, value] of Object.entries(node.inputs)) {
      if (!isComfyLink(value)) continue
      const schema = specs.get(input)
      const role = mediaRole(input)
      if (!isReferencePort(node, input, kind, family, schema)) continue
      const loaders = [...ancestors([value[0]])].filter((source) => loaderKind(prompt[source]) === kind)
      if (loaders.length === 1) targets.push({ id: loaders[0], index: role?.index ?? null, consumer: id })
      else if (loaders.length > 1) throw new ComfyError(`${id}.${input} 有多个上游参考文件节点；请用 files 精确指定。`)
    }
  }
  const unique = [...new Set(targets.map(({ id }) => id))]
  if (unique.length < 2) return unique
  const firstConsumer = targets[0]?.consumer
  if (targets.length === unique.length && targets.every(({ index, consumer }) => index !== null && consumer === firstConsumer)
      && new Set(targets.map(({ index }) => index)).size === targets.length) {
    return targets.sort((a, b) => a.index - b.index).map(({ id }) => id)
  }
  // The old positional order is usable only when every detected loader still
  // reaches the same H3 consumer via a matching typed reference socket.
  const legacy = DEFAULT_WORKFLOWS[family]?.[`${kind}_nodes`] || []
  if (family === 'video' && targets.every(({ consumer }) => consumer === firstConsumer) && unique.every((id) => legacy.includes(id))) {
    return legacy.filter((id) => unique.includes(id))
  }
  throw new ComfyError(`${kind} 参考文件节点顺序不明确；请用 files 精确指定。`)
}

function missingInstanceFile(prompt, objectInfo, id, kind) {
  const value = prompt[id].inputs[kind]
  const options = comfyComboOptions(nodeSpecs(prompt, objectInfo, id).get(kind)?.spec)
  if (value == null || value === '') return true
  if (typeof value !== 'string' || /\s\[(?:output|temp)\]$/.test(value) || options === null) return false
  const path = value.replace(/\s\[input\]$/, '').replaceAll('\\', '/')
  return !options.some((option) => typeof option === 'string'
    && (option.replaceAll('\\', '/') === path || option.replaceAll('\\', '/').endsWith(`/${path}`)))
}

function isReferencePort(node, input, kind, family, schema) {
  const type = schema?.spec?.[0]
  if (family === 'video') {
    return H3_NODE.test(node.class_type) && mediaRole(input)?.kind === kind
      && (type === MEDIA[kind] || (kind === 'video' && type === 'IMAGE'))
  }
  if (kind !== 'image') return false
  if (node.class_type === 'ReferenceLatent' && input === 'latent' && type === 'LATENT') return true
  return type === 'IMAGE' && mediaRole(input)?.kind === 'image'
    && (schema.required === false || /(?:^|[._])ref(?:erence)?_?/i.test(input))
}

function removeUnusedReferences(prompt, objectInfo, family, activeGraph, protectedNodes, overrides, warnings) {
  const { active, outputs, ancestors } = activeGraph
  const consumers = new Map()
  for (const id of active) {
    for (const [input, value] of Object.entries(record(prompt[id]?.inputs))) {
      if (!isComfyLink(value)) continue
      const source = String(value[0])
      const edges = consumers.get(source) || []
      edges.push({ id, input, source })
      consumers.set(source, edges)
    }
  }
  for (const id of active) {
    const node = prompt[id]
    const kind = loaderKind(node)
    if (!kind || protectedNodes.has(id)) continue
    const value = node.inputs[kind]
    const missing = missingInstanceFile(prompt, objectInfo, id, kind)
    if (family === 'image' && !missing) continue
    const cuts = []
    const stack = [id]
    const visited = new Set()
    let required = false
    while (stack.length) {
      const source = stack.pop()
      if (visited.has(source)) continue
      visited.add(source)
      if (outputs.includes(source)) required = true
      for (const edge of consumers.get(source) || []) {
        const schema = nodeSpecs(prompt, objectInfo, edge.id).get(edge.input)
        const consumer = prompt[edge.id]
        const optionalReference = schema?.required === false && isReferencePort(consumer, edge.input, kind, family, schema)
        const explicitlyConnected = Object.hasOwn(record(overrides?.[edge.id]), edge.input)
        if (optionalReference && !explicitlyConnected) {
          const protectedBranch = [...ancestors([source])].some((ancestor) => {
            if (protectedNodes.has(ancestor)) return true
            const media = loaderKind(prompt[ancestor])
            return family === 'image' && media && !missingInstanceFile(prompt, objectInfo, ancestor, media)
          })
          if (!protectedBranch) {
            cuts.push(edge)
            continue
          }
        }
        stack.push(edge.id)
      }
    }
    if (required) {
      if (missing) throw new ComfyError(`节点 ${id}（${node.class_type}）所需的文件 ${JSON.stringify(value ?? '')} 不在当前实例中；请用 files.${id} 提供文件。`)
      continue
    }
    for (const { id: consumer, input, source } of cuts) {
      if (String(prompt[consumer]?.inputs[input]?.[0]) === source) delete prompt[consumer].inputs[input]
    }
    if (cuts.length && family === 'image') warnings.push(`已省略节点 ${id} 的缺失参考文件；它只连接到可选输入。`)
  }
}

export function prepareWorkflow(workflow, objectInfo, job, { config = {} } = {}) {
  const warnings = []
  const oldDefault = !Object.hasOwn(job, 'workflow_default_type') && oldDefaultType(job)
  const old = DEFAULT_WORKFLOWS[oldDefault]
  const automatic = job.workflow_adaptation !== false && config.workflowAdaptation !== false
  const manualNodes = new Set([...Object.keys(record(job.files)), ...Object.keys(record(job.overrides))])
  const uiLoaders = (Array.isArray(workflow.nodes) ? workflow.nodes : []).filter((node) => loaderKind(node) && node.mode === 4)
  const convert = (activate) => {
    const converted = convertWorkflowToPrompt(workflow, objectInfo, { activate, preserveUnknown: true })
    const raw = promptFromConversion(converted)
    const prompt = Object.fromEntries(Object.entries(raw).map(([id, node]) => [id, { ...node, inputs: { ...record(node?.inputs) } }]))
    return { prompt, skipped: converted.skipped || [] }
  }
  const activate = new Set(uiLoaders.map(({ id }) => String(id)).filter((id) => manualNodes.has(id)))
  let converted = convert(activate)
  let prompt = converted.prompt
  let currentGraph = graph(prompt, objectInfo)
  const detected = automatic ? families(prompt, objectInfo, currentGraph.active) : new Set()
  const family = detected.size === 1 ? [...detected][0] : ''
  if (old && family === oldDefault && job.prompt_node === old.prompt_node && job.prompt_input === old.prompt_input) {
    // Older jobs persisted a prompt target even when the user had not selected
    // one. Prefer the stored target if it still matches the effective graph.
    const stillApplicable = bindingCandidates(prompt, objectInfo, currentGraph.active, 'prompt', {}, family)
      .some(({ node_id, input }) => node_id === old.prompt_node && input === old.prompt_input)
    if (!stillApplicable) {
      if (!prompt[old.prompt_node]) {
        job = { ...job, prompt_node: '', prompt_input: '' }
        warnings.push(`旧任务的提示词节点 ${old.prompt_node} 已不存在，按当前工作流匹配提示词。`)
      } else {
        throw new ComfyError(`旧任务的提示词位置 ${old.prompt_node}.${old.prompt_input} 与当前工作流不符；请重新提交并指定提示词参数。`)
      }
    }
  }

  const files = Object.create(null)
  for (const [id, source] of Object.entries(record(job.files))) files[id] = fileBinding(prompt, objectInfo, id, source)
  for (const kind of Object.keys(MEDIA)) {
    const references = job[`reference_${kind}s`] || []
    if (!references.length) continue
    if (!family) throw new ComfyError(`reference_${kind}s 需要可识别的内置工作流；请用 files 指定节点。`)
    const possible = convert(new Set([...activate, ...uiLoaders.map(({ id }) => String(id))])).prompt
    const possibleGraph = graph(possible, objectInfo)
    const ids = referenceTargets(possible, objectInfo, possibleGraph.active, possibleGraph.ancestors, kind, family)
      .filter((id) => !files[id] && !Object.hasOwn(record(job.overrides?.[id]), kind))
    if (references.length > ids.length) throw new ComfyError(`工作流只找到 ${ids.length} 个可用的 ${kind} 参考文件位置；请检查工作流或用 files 精确指定。`)
    references.forEach((path, index) => {
      const id = ids[index]
      files[id] = fileBinding(possible, objectInfo, id, path)
      activate.add(id)
      manualNodes.add(id)
    })
  }
  if (Object.keys(files).length) {
    converted = convert(activate)
    prompt = converted.prompt
  }

  const apply = (id, input, value) => {
    const entry = nodeSpecs(prompt, objectInfo, id).get(input)
    if (!entry) throw new ComfyError(`工作流节点 ${id} 没有参数 ${input}；请检查当前实例中的节点定义。`)
    if (files[id]?.input === input) throw new ComfyError(`节点 ${id}.${input} 同时指定了上传文件和参数值。`)
    prompt[id].inputs[input] = isComfyLink(value) ? value : validateLiteral(value, entry.spec, `${id}.${input}`)
  }
  for (const [id, inputs] of Object.entries(record(job.overrides))) {
    if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs) || !Object.hasOwn(prompt, id)) {
      throw new ComfyError(`overrides.${id} 必须指定当前工作流节点及其参数对象。`)
    }
    for (const [input, value] of Object.entries(inputs)) apply(id, input, value)
  }
  currentGraph = graph(prompt, objectInfo)
  if (!currentGraph.outputs.length) throw new ComfyError('工作流没有可运行的输出节点。')
  for (const id of manualNodes) {
    if (!currentGraph.active.has(id)) throw new ComfyError(`显式指定的节点 ${id} 未连接到有效输出；请检查工作流中的连线和旁路设置。`)
  }
  // Remove graph islands and missing references whose every path crosses an optional input.
  if (family) removeUnusedReferences(prompt, objectInfo, family, currentGraph, manualNodes, job.overrides, warnings)
  const { active } = graph(prompt, objectInfo)
  for (const id of manualNodes) {
    if (!active.has(id)) throw new ComfyError(`可选参考分支与显式指定的节点 ${id} 冲突；请检查连线并提供所需文件。`)
  }
  const promptTarget = {}
  for (const role of FIELD_NAMES) {
    const value = job[role]
    if (value == null || value === '') continue
    if (role !== 'prompt' && !family) throw new ComfyError(`${role} 需要可识别的内置工作流；请用 overrides 指定参数。`)
    const { node_id: id, input } = chooseBinding(prompt, objectInfo, active, role, job, family)
    if (Object.hasOwn(record(job.overrides?.[id]), input) && prompt[id].inputs[input] !== value) {
      throw new ComfyError(`${role} 与 overrides.${id}.${input} 同时设置了不同的值。`)
    }
    apply(id, input, value)
    if (role === 'prompt') Object.assign(promptTarget, { node_id: id, input })
  }

  const finalPrompt = Object.fromEntries(Object.entries(prompt).filter(([id]) => active.has(id)))
  for (const id of active) {
    const node = finalPrompt[id]
    if (!node) throw new ComfyError(`工作流缺少仍被引用的节点 ${id}。`)
    if (!objectInfo[node.class_type]) throw new ComfyError(`当前实例缺少输出分支上的节点类型 ${node.class_type}（节点 ${id}）。`)
    if (!family) continue
    for (const [name, entry] of nodeSpecs(finalPrompt, objectInfo, id)) {
      if (entry.required && node.inputs[name] == null && files[id]?.input !== name) {
        throw new ComfyError(`工作流节点 ${id}（${node.class_type}）缺少必需参数 ${name}；请检查工作流连线或指定参数。`)
      }
    }
  }
  const missingUnused = converted.skipped?.filter(({ node_id }) => !active.has(node_id))
  if (missingUnused?.length) warnings.push(`已省略未连接输出的节点：${missingUnused.map(({ node_id, type }) => `${node_id}:${type}`).join('、')}`)
  return { prompt: finalPrompt, promptTarget: promptTarget.node_id ? promptTarget : null, warnings, files, family }
}
