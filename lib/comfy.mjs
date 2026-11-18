/** ComfyUI client and UI-workflow → API-prompt converter for a user's GPU instance. */

import { readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { workspaceDirectory, workspaceFile } from './workspace.mjs'

export class ComfyError extends Error {
  constructor(message, { status = 0, payload = undefined } = {}) {
    super(message)
    this.name = 'ComfyError'
    this.status = status
    this.payload = payload
  }
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}

const FRONTEND_ONLY_NODE_TYPES = new Set(['Reroute', 'Note', 'MarkdownNote', 'GetNode', 'SetNode'])

const objectInfoCache = new Map()

export function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '')
}

export function comfyServiceUrl(instance) {
  if (!instance || typeof instance !== 'object') return ''
  const services = Array.isArray(instance.server_map) ? instance.server_map : []
  const httpServices = services.filter((service) => service && service.port_type === 'http' && service.url)
  const preferred = httpServices.find((service) => /webui|comfy/i.test(String(service.title || '')))
  return normalizeBaseUrl(preferred?.url || httpServices[0]?.url || (Array.isArray(instance.server_url) ? instance.server_url.find((url) => /^https?:/i.test(String(url))) : '') || '')
}

export function instanceStatusName(status) {
  switch (Number(status)) {
    case 0: return '已创建'
    case 1: return '开机中（首次创建）'
    case 2: return '运行中'
    case 3: return '关机中'
    case 4: return '已关机'
    case 21: return '关机中'
    case 22: return '已关机'
    case 23: return '已关机（异常）'
    case 24: return '开机中'
    case 27: return '重启中'
    default: return `未知状态 ${status}`
  }
}

export function sanitizeInstance(instance, { includeServices = true } = {}) {
  if (!instance || typeof instance !== 'object') return instance
  const result = {
    instance_uuid: instance.instance_uuid,
    title: instance.title || '',
    status: instance.status,
    status_name: instanceStatusName(instance.status),
    gpu_name: instance.gpu_name,
    gpu_uuid: instance.gpu_uuid,
    gpu_nums: instance.gpu_nums,
    pod_uuid: instance.pod_uuid,
    image_name: instance.image_name,
    image_tag: instance.image_tag,
    create_time: instance.create_time,
    start_time: instance.start_time,
    shutdown_regular: instance.shutdown_regular,
  }
  if (includeServices) {
    result.comfy_url = comfyServiceUrl(instance)
    result.services = (Array.isArray(instance.server_map) ? instance.server_map : [])
      .filter((service) => service && service.port_type === 'http')
      .map((service) => ({ title: service.title, url: String(service.url || '').replace(/([?&]token=)[^&]+/i, '$1***') }))
  }
  return result
}

export function createComfyClient(baseUrl, { defaultTimeoutMs = 60_000 } = {}) {
  const root = normalizeBaseUrl(baseUrl)

  async function request(path, { method = 'GET', body, form, signal, timeoutMs } = {}) {
    const timeout = timeoutMs ?? defaultTimeoutMs
    const timeoutSignal = AbortSignal.timeout(timeout)
    const composite = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const init = { method, signal: composite, headers: {} }
    if (form) {
      init.body = form
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
    let response
    try {
      response = await fetch(root + path, init)
    } catch (error) {
      const message = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `ComfyUI 请求超时（${Math.round(timeout / 1000)} 秒）`
        : `ComfyUI 请求失败：${String(error?.message ?? error)}`
      throw new ComfyError(message)
    }
    const text = await response.text()
    let data
    try { data = text ? JSON.parse(text) : {} } catch { data = undefined }
    const htmlTitle = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() || ''
    const htmlPage = /^\s*<!doctype|<html/i.test(text)
    if (!response.ok) {
      const error = data?.error
      const message = (typeof error === 'string' ? error : error?.message) || (htmlPage
        ? `ComfyUI 服务暂未就绪（HTTP ${response.status}${htmlTitle ? `：${htmlTitle}` : ''}）`
        : text.slice(0, 300) || `HTTP ${response.status}`)
      throw new ComfyError(message, {
        status: response.status,
        payload: data,
      })
    }
    if (data === undefined && htmlPage) {
      throw new ComfyError(`ComfyUI 服务暂未就绪（HTTP ${response.status}${htmlTitle ? `：${htmlTitle}` : ''}）`, {
        status: response.status,
        payload: undefined,
      })
    }
    return data
  }

  return {
    baseUrl: root,
    get: (path, options) => request(path, options),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    async uploadFile(filePath, { signal, subfolder = '', overwrite = true } = {}) {
      const buffer = await readFile(filePath)
      const info = await stat(filePath)
      if (!info.isFile()) throw new ComfyError(`不是普通文件：${filePath}`)
      const form = new FormData()
      const mime = MIME_BY_EXT[extname(filePath).toLowerCase()] || 'application/octet-stream'
      form.append('image', new Blob([buffer], { type: mime }), basename(filePath))
      form.append('type', 'input')
      if (subfolder) form.append('subfolder', subfolder)
      if (overwrite) form.append('overwrite', 'true')
      return request('/upload/image', { method: 'POST', form, signal, timeoutMs: 300_000 })
    },
  }
}

export async function waitForComfyReady(baseUrl, { timeoutMs = 300_000, intervalMs = 5_000, requiredHits = 2, signal, onTick } = {}) {
  const client = createComfyClient(baseUrl, { defaultTimeoutMs: 15_000 })
  const deadline = Date.now() + timeoutMs
  const startedAt = Date.now()
  let lastError = ''
  let hits = 0
  while (Date.now() <= deadline) {
    try {
      const stats = await client.get('/system_stats', { signal })
      if (!stats?.system?.comfyui_version) throw new ComfyError('ComfyUI /system_stats 尚未返回版本信息')
      const queue = await client.get('/queue', { signal })
      if (!queue || typeof queue !== 'object' || !Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending)) {
        throw new ComfyError('ComfyUI /queue 尚未就绪')
      }
      hits += 1
      if (hits >= Math.max(1, requiredHits)) return stats
    } catch (error) {
      hits = 0
      lastError = String(error?.message ?? error)
    }
    onTick?.({ elapsed_ms: Date.now() - startedAt, last_error: lastError })
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal)
  }
  throw new ComfyError(`ComfyUI 未在 ${Math.round(timeoutMs / 1000)} 秒内就绪${lastError ? `（最后错误：${lastError}）` : ''}`)
}

export async function listComfyWorkflows(baseUrl, { signal } = {}) {
  const client = createComfyClient(baseUrl)
  let items
  let modern = true
  try {
    items = await client.get('/v2/userdata?path=workflows', { signal })
  } catch (error) {
    if (![400, 404, 405, 501].includes(error.status)) throw error
    modern = false
    try {
      items = await client.get('/userdata?dir=workflows&recurse=true', { signal })
    } catch (legacyError) {
      if (legacyError.status === 404) return []
      throw legacyError
    }
  }
  if (!Array.isArray(items)) throw new ComfyError('ComfyUI 工作流目录未返回文件列表。')
  const names = items.flatMap((item) => {
    if (item?.type === 'directory') return []
    const path = typeof item === 'string' ? item : item?.path || item?.name
    if (typeof path !== 'string') return []
    const relative = modern ? path.replace(/^workflows\//, '') : path
    return !/[\\%\x00-\x1f]/.test(relative) && relative.split('/').every((part) => part && part !== '.' && part !== '..')
      ? [relative] : []
  })
  return [...new Set(names)]
}

export async function readComfyWorkflow(baseUrl, workflowName, { signal } = {}) {
  if (typeof workflowName !== 'string' || /[\\%\x00-\x1f]/.test(workflowName)
      || workflowName.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new ComfyError('workflow_name 必须是 workflows 目录内的相对文件名。')
  }
  const client = createComfyClient(baseUrl)
  const encoded = encodeURIComponent(`workflows/${workflowName}`)
  const data = await client.get(`/userdata/${encoded}`, { signal, timeoutMs: 120_000 })
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ComfyError(`工作流 ${workflowName} 未返回 JSON 对象。`)
  return data
}

export async function getComfyObjectInfo(baseUrl, { signal, fresh = false } = {}) {
  const key = normalizeBaseUrl(baseUrl)
  const cached = objectInfoCache.get(key)
  if (!fresh && cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.data
  const client = createComfyClient(key, { defaultTimeoutMs: 120_000 })
  const data = await client.get('/object_info', { signal })
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.values(data).some((def) => def?.input)) {
    throw new ComfyError('ComfyUI /object_info 尚未返回有效节点信息。')
  }
  objectInfoCache.set(key, { data, at: Date.now() })
  return data
}

function linkTuple(link) {
  if (Array.isArray(link)) {
    return { id: String(link[0]), originId: String(link[1]), originSlot: Number(link[2]), targetId: String(link[3]), targetSlot: Number(link[4]), type: link[5] }
  }
  if (link && typeof link === 'object') {
    return {
      id: String(link.id),
      originId: String(link.origin_id ?? link.originId),
      originSlot: Number(link.origin_slot ?? link.originSlot ?? 0),
      targetId: String(link.target_id ?? link.targetId),
      targetSlot: Number(link.target_slot ?? link.targetSlot ?? 0),
      type: link.type,
    }
  }
  return undefined
}

export function comfyComboOptions(spec) {
  if (Array.isArray(spec?.[0])) return spec[0]
  if (spec?.[0] === 'COMBO' && Array.isArray(spec?.[1]?.options)) return spec[1].options
  if (spec?.[0] === 'COMFY_DYNAMICCOMBO_V3' && Array.isArray(spec[1]?.options)) return spec[1].options.map(({ key }) => key)
  return null
}

export function isComfyLink(value) {
  return Array.isArray(value) && value.length === 2
    && typeof value[0] === 'string' && Number.isInteger(value[1]) && value[1] >= 0
}

export function comfyInputSpecs(nodeDef, values = {}) {
  const result = new Map()
  function add(input, order, prefix = '') {
    for (const section of ['required', 'optional']) {
      const specs = input?.[section] || {}
      const keys = [...new Set([...(order?.[section] || []), ...Object.keys(specs)])]
      for (const key of keys) {
        const name = `${prefix}${key}`
        const spec = specs[key]
        if (!Array.isArray(spec)) continue
        const required = section === 'required'
        if (spec[0] === 'COMFY_AUTOGROW_V3') {
          const template = spec[1]?.template
          if (!template) continue
          const requiredTemplate = Object.values(template.input?.required || {})[0]
          const childSpec = requiredTemplate || Object.values(template.input?.optional || {})[0]
          if (!childSpec) continue
          const names = template.names || (typeof template.prefix === 'string'
            ? Array.from({ length: Math.min(template.max || 0, 100) }, (_, index) => `${template.prefix}${index}`) : [])
          names.forEach((child, index) => result.set(`${name}.${child}`, { spec: childSpec, required: Boolean(requiredTemplate && index < (template.min ?? 1)) }))
          continue
        }
        result.set(name, { spec, required })
        if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
          const selected = spec[1]?.options?.find((option) => option.key === values[name])
          if (selected) add(selected.inputs, undefined, `${name}.`)
        }
      }
    }
  }
  add(nodeDef?.input, nodeDef?.input_order)
  return result
}

function isWidgetInput(spec) {
  if (spec?.[1]?.forceInput || spec?.[1]?.force_input) return false
  return comfyComboOptions(spec) !== null || ['STRING', 'INT', 'FLOAT', 'BOOLEAN', 'COMBO'].includes(spec?.[0])
}

/**
 * Convert a ComfyUI UI workflow (nodes/links) into the API prompt format
 * accepted by POST /prompt. Handles Reroute and Set/Get helper nodes and
 * bypassed (mode 4) nodes. Unknown/front-end-only nodes are skipped.
 */
export function convertWorkflowToPrompt(workflow, objectInfo, { activate = new Set(), preserveUnknown = false } = {}) {
  if (!workflow || typeof workflow !== 'object') throw new ComfyError('工作流 JSON 为空或格式不正确。')
  if (!Array.isArray(workflow.nodes)) {
    // Already an API-format prompt keyed by node id.
    const candidate = workflow.prompt && !workflow.prompt.class_type ? workflow.prompt : workflow
    const entries = candidate && typeof candidate === 'object' && !Array.isArray(candidate) ? Object.values(candidate) : []
    if (entries.length > 0 && entries.every((value) => value && typeof value === 'object' && typeof value.class_type === 'string')) {
      return candidate
    }
    throw new ComfyError('工作流不是 ComfyUI 的 UI 格式（缺少 nodes）也不是 API prompt 格式。')
  }

  const nodes = new Map(workflow.nodes.map((node) => [String(node.id), node]))
  const links = new Map()
  for (const raw of workflow.links || []) {
    const link = linkTuple(raw)
    if (link) links.set(link.id, link)
  }
  const setters = new Map()
  for (const node of workflow.nodes) {
    if (node.type !== 'SetNode') continue
    const name = node.widgets_values?.[0] ?? node.widgets_values_named?.name ?? node.title
    if (name != null) setters.set(String(name), node)
  }

  function resolveOutput(nodeId, outputSlot, depth = 0) {
    if (depth > 100) return null
    const node = nodes.get(String(nodeId))
    if (!node) return null
    if (node.type === 'Reroute') {
      const inputLinkId = node.inputs?.[0]?.link
      const link = inputLinkId == null ? undefined : links.get(String(inputLinkId))
      return link ? resolveOutput(link.originId, link.originSlot, depth + 1) : null
    }
    if (node.type === 'GetNode') {
      const name = node.widgets_values?.[0] ?? node.widgets_values_named?.name
      const setter = setters.get(String(name))
      const inputLinkId = setter?.inputs?.[0]?.link
      const link = inputLinkId == null ? undefined : links.get(String(inputLinkId))
      return link ? resolveOutput(link.originId, link.originSlot, depth + 1) : null
    }
    if (node.type === 'SetNode') {
      const inputLinkId = node.inputs?.[0]?.link
      const link = inputLinkId == null ? undefined : links.get(String(inputLinkId))
      return link ? resolveOutput(link.originId, link.originSlot, depth + 1) : null
    }
    if (!activate.has(nodeId) && node.mode === 4) {
      const outputType = node.outputs?.[outputSlot]?.type
      const matchingInput = (node.inputs || []).find((input) => {
        if (input?.link == null) return false
        if (input.type === outputType) return true
        return input.type === '*' || outputType === '*'
      })
      if (!matchingInput) return null
      const link = links.get(String(matchingInput.link))
      return link ? resolveOutput(link.originId, link.originSlot, depth + 1) : null
    }
    if (!activate.has(nodeId) && node.mode === 2) return null
    return [String(node.id), outputSlot]
  }

  const prompt = {}
  const skipped = []
  for (const node of workflow.nodes) {
    const nodeId = String(node.id)
    if (!activate.has(nodeId) && (node.mode === 2 || node.mode === 4)) continue
    if (FRONTEND_ONLY_NODE_TYPES.has(node.type)) continue
    const nodeDef = objectInfo[node.type]
    if (!nodeDef) {
      skipped.push({ node_id: nodeId, type: node.type, reason: 'ComfyUI 后端没有这个节点类型（可能是前端辅助节点）' })
      if (!preserveUnknown) continue
    }
    const inputs = Object.create(null)
    const slots = new Set()
    const linked = new Set()
    for (const input of node.inputs || []) {
      if (!input?.name) continue
      slots.add(input.name)
      if (input.link == null) continue
      linked.add(input.name)
      const link = links.get(String(input.link))
      const source = link ? resolveOutput(link.originId, link.originSlot) : null
      if (source) inputs[input.name] = source
    }

    // VHS and newer saves can supply widget names directly. A disconnected
    // link must never fall back to a stale widget value.
    const saved = node.widgets_values
    const named = node.widgets_values_named || (saved && !Array.isArray(saved) && typeof saved === 'object' ? saved : undefined)
    if (named) {
      const specs = comfyInputSpecs(nodeDef, { ...named, ...inputs })
      for (const [name, value] of Object.entries(named)) {
        if (!linked.has(name) && (specs.has(name) || slots.has(name))) inputs[name] = value
      }
    } else if (Array.isArray(saved)) {
      let index = 0
      const visited = new Set()
      let widgets = comfyInputSpecs(nodeDef, inputs)
      for (const [name, { spec }] of widgets) {
        if (!isWidgetInput(spec)) continue
        visited.add(name)
        if (linked.has(name)) {
          // Linked converted widgets are usually serialized as null, or absent.
          if (saved[index] === null) index += 1
          continue
        }
        if (index >= saved.length) break
        const value = saved[index++]
        if (value !== null) inputs[name] = value
        if ((spec[1]?.control_after_generate || /(?:^|_)seed$/.test(name))
            && ['fixed', 'randomize', 'increment', 'decrement'].includes(saved[index])) index += 1
        if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
          // The selected option can contribute more widgets in this same order.
          const expanded = comfyInputSpecs(nodeDef, inputs)
          for (const key of widgets.keys()) if (!visited.has(key)) widgets.delete(key)
          for (const [key, next] of expanded) if (!visited.has(key)) widgets.set(key, next)
        }
      }
    }
    prompt[String(node.id)] = {
      class_type: node.type,
      inputs,
      _meta: { title: node.title || node.type },
    }
  }
  return { prompt, skipped }
}

export function promptFromConversion(converted) {
  if (converted && typeof converted === 'object' && converted.prompt && typeof converted.prompt === 'object') return converted.prompt
  return converted
}

export async function describeComfyWorkflow(workflow, objectInfo) {
  const converted = convertWorkflowToPrompt(workflow, objectInfo)
  const prompt = promptFromConversion(converted)
  const skipped = Array.isArray(converted?.skipped) ? converted.skipped : []
  const parameters = []
  const textInputs = []
  const outputNodes = []
  for (const [nodeId, node] of Object.entries(prompt)) {
    const classType = String(node.class_type || '')
    if (/^(SaveImage|SaveAnimated|SaveAudio|SaveVideo|VHS_VideoCombine|PreviewImage|PreviewAny)/i.test(classType)) {
      outputNodes.push({ node_id: nodeId, class_type: classType, title: node._meta?.title || classType })
    }
    for (const [inputName, value] of Object.entries(node.inputs || {})) {
      if (Array.isArray(value) && value.length === 2 && (typeof value[0] === 'string' || typeof value[0] === 'number') && Number.isInteger(Number(value[1]))) {
        continue
      }
      if (value === null || value === undefined) continue
      const rendered = typeof value === 'string' ? value : JSON.stringify(value)
      const item = {
        node_id: nodeId,
        class_type: classType,
        title: node._meta?.title || classType,
        input: inputName,
        value: typeof value === 'string' && value.length > 1200 ? `${value.slice(0, 1200)}…` : value,
      }
      parameters.push(item)
      const isFilePath = typeof value === 'string' && /\.(safetensors|gguf|pt|pth|bin|ckpt|onnx)$/i.test(value)
      if (!isFilePath && (/text|prompt|提示词/i.test(inputName) && !/name|filename/i.test(inputName) || (typeof value === 'string' && value.length >= 80))) {
        textInputs.push(item)
      }
    }
  }
  return {
    node_count: Object.keys(prompt).length,
    output_nodes: outputNodes,
    text_inputs: textInputs.slice(0, 60),
    parameters: parameters.slice(0, 300),
    parameters_truncated: parameters.length > 300,
    skipped_nodes: skipped,
  }
}

/**
 * ComfyUI combo widgets often store only a basename while the actual option
 * list contains a subfolder (for example "KOOK.safetensors" vs
 * "MOSS/KOOK.safetensors"). Fix unambiguous basename matches automatically.
 */
export function normalizePromptComboValues(prompt, objectInfo) {
  const warnings = []
  for (const [nodeId, node] of Object.entries(prompt || {})) {
    const def = objectInfo?.[node?.class_type]
    if (!def) continue
    for (const section of ['required', 'optional']) {
      for (const [inputName, spec] of Object.entries(def?.input?.[section] || {})) {
        const options = Array.isArray(spec?.[0]) ? spec[0] : null
        if (!options || options.length === 0) continue
        const value = node.inputs?.[inputName]
        if (typeof value !== 'string' || options.includes(value)) continue
        const candidates = options.filter((option) => typeof option === 'string' && (option.endsWith(`/${value}`) || option.split('/').pop() === value))
        if (candidates.length === 1) {
          node.inputs[inputName] = candidates[0]
          warnings.push(`节点 ${nodeId} 的 ${inputName} 自动补全为 ${candidates[0]}`)
        }
      }
    }
  }
  return { warnings }
}

export function applyPromptOverrides(prompt, overrides) {
  if (!overrides || typeof overrides !== 'object') return prompt
  for (const [nodeId, values] of Object.entries(overrides)) {
    const key = String(nodeId)
    const node = prompt[key]
    if (!node) throw new ComfyError(`工作流里没有节点 ${key}；请先调用 chenyu_instance_workflow_inspect 查看可用节点。`)
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new ComfyError(`overrides.${key} 必须是 { 参数名: 值 } 对象。`)
    }
    for (const [inputName, value] of Object.entries(values)) {
      node.inputs[inputName] = value
    }
  }
  return prompt
}

function inferFileInput(classType) {
  const type = String(classType || '')
  if (/LoadImage$/i.test(type) || /LoadImageMask$/i.test(type)) return 'image'
  if (/VHS_LoadVideo/i.test(type) || /LoadVideo/i.test(type)) return 'video'
  if (/LoadAudio/i.test(type)) return 'audio'
  return ''
}

export async function uploadWorkflowFiles(client, prompt, files, { signal, baseDir = process.cwd(), workspaceOnly = false } = {}) {
  const uploaded = []
  if (!files || typeof files !== 'object') return uploaded
  for (const [nodeId, spec] of Object.entries(files)) {
    const key = String(nodeId)
    const node = prompt[key]
    if (!node) throw new ComfyError(`files 里指定的节点 ${key} 不存在。`)
    const rawPath = typeof spec === 'string' ? spec : spec?.path
    if (!rawPath) throw new ComfyError(`files.${key} 缺少本地文件路径。`)
    const filePath = workspaceOnly ? await workspaceFile(baseDir, String(rawPath), `files.${key}`) : resolve(baseDir, String(rawPath))
    const inputName = (typeof spec === 'object' ? spec.input : undefined) || inferFileInput(node.class_type)
    if (!inputName) throw new ComfyError(`无法推断节点 ${key}（${node.class_type}）的文件参数名；请传 {path, input}。`)
    const result = await client.uploadFile(filePath, { signal })
    const widgetValue = result?.subfolder ? `${result.subfolder}/${result.name}` : result?.name
    node.inputs[inputName] = widgetValue
    uploaded.push({ node_id: key, class_type: node.class_type, input: inputName, local_path: filePath, comfy_name: widgetValue })
  }
  return uploaded
}

function summarizeNodeErrors(nodeErrors) {
  const parts = []
  for (const [nodeId, value] of Object.entries(nodeErrors || {})) {
    const classType = value?.class_type ? ` ${value.class_type}` : ''
    const messages = Array.isArray(value?.errors) ? value.errors : []
    for (const item of messages.slice(0, 2)) {
      const text = typeof item === 'string' ? item : item?.message || item?.details || JSON.stringify(item)
      parts.push(`节点 ${nodeId}${classType}：${String(text).slice(0, 300)}`)
    }
  }
  return parts.slice(0, 5).join('；')
}

export async function submitComfyPrompt(baseUrl, prompt, { clientId = `dsh-${Date.now()}`, signal } = {}) {
  const client = createComfyClient(baseUrl, { defaultTimeoutMs: 120_000 })
  try {
    const result = await client.post('/prompt', { prompt, client_id: clientId }, { signal })
    if (!result?.prompt_id) throw new ComfyError('ComfyUI 没有返回 prompt_id。', { payload: result })
    return result
  } catch (error) {
    const detail = summarizeNodeErrors(error.payload?.node_errors)
    if (!detail) throw error
    throw new ComfyError(`${error.message}：${detail}`, { status: error.status, payload: error.payload })
  }
}

/**
 * Follow one ComfyUI prompt over its WebSocket. Returns a close function; all
 * errors are ignored because progress is an optimization, never required for
 * correctness. Messages are scoped by prompt_id when ComfyUI provides one.
 */
export function watchComfyPromptProgress(baseUrl, promptId, { clientId = '', onProgress } = {}) {
  if (typeof WebSocket !== 'function') return () => {}
  let socket
  try {
    const url = new URL('/ws', normalizeBaseUrl(baseUrl))
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (clientId) url.searchParams.set('clientId', clientId)
    socket = new WebSocket(url)
  } catch {
    return () => {}
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { socket?.close() } catch { /* ignore */ }
  }
  const handleMessage = (raw) => {
    if (closed) return
    let message
    try { message = JSON.parse(String(raw)) } catch { return }
    const data = message?.data && typeof message.data === 'object' ? message.data : {}
    const messagePrompt = data.prompt_id || data.promptId
    if (messagePrompt && String(messagePrompt) !== String(promptId)) return
    const type = String(message?.type || '')
    if (type === 'progress' && Number.isFinite(Number(data.value)) && Number.isFinite(Number(data.max)) && Number(data.max) > 0) {
      onProgress?.({ type, value: Number(data.value), max: Number(data.max), node: data.node, prompt_id: messagePrompt })
      return
    }
    if (type === 'executing' || type === 'execution_start' || type === 'execution_success' || type === 'execution_error' || type === 'execution_interrupted') {
      onProgress?.({ type, node: data.node, prompt_id: messagePrompt })
    }
  }
  socket.addEventListener('message', (event) => {
    const raw = event.data
    if (typeof raw === 'string') {
      handleMessage(raw)
      return
    }
    if (raw && typeof raw.text === 'function') {
      raw.text().then(handleMessage).catch(() => {})
      return
    }
    if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) handleMessage(Buffer.from(raw).toString('utf8'))
  })
  socket.addEventListener('error', () => close())
  socket.addEventListener('close', () => { closed = true })
  return close
}

export async function waitForComfyPrompt(baseUrl, promptId, { timeoutMs = 1_800_000, intervalMs = 2_500, signal } = {}) {
  const client = createComfyClient(baseUrl)
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const history = await client.get(`/history/${encodeURIComponent(promptId)}`, { signal, timeoutMs: 30_000 })
    const entry = history?.[promptId]
    if (entry) {
      const statusText = entry?.status?.status_str || ''
      const completed = entry?.status?.completed === true
      if (statusText === 'error' || entry?.status?.messages?.some((message) => Array.isArray(message) && message[0] === 'execution_error')) {
        return { ok: false, status: 'failed', history: entry }
      }
      if (completed || statusText === 'success') {
        return { ok: true, status: 'succeeded', history: entry }
      }
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal)
  }
  throw new ComfyError(`等待 ComfyUI 工作流超过 ${Math.round(timeoutMs / 1000)} 秒仍未完成。`)
}

export function collectComfyOutputFiles(historyEntry) {
  const files = []
  const outputs = historyEntry?.outputs
  if (!outputs || typeof outputs !== 'object') return files
  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== 'object') continue
    for (const [outputKey, value] of Object.entries(nodeOutput)) {
      const list = Array.isArray(value) ? value : [value]
      for (const item of list) {
        if (!item || typeof item !== 'object' || typeof item.filename !== 'string') continue
        files.push({
          node_id: nodeId,
          output_key: outputKey,
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        })
      }
    }
  }
  return files
}

export async function downloadComfyOutputFiles(baseUrl, files, outputDir, { signal, timeoutMs = 600_000, workspace } = {}) {
  await mkdir(outputDir, { recursive: true })
  const results = []
  let index = 0
  for (const file of files) {
    index += 1
    const url = new URL('/view', baseUrl)
    url.searchParams.set('filename', file.filename)
    url.searchParams.set('subfolder', file.subfolder || '')
    url.searchParams.set('type', file.type || 'output')
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal })
    if (!response.ok) {
      results.push({ ...file, error: `HTTP ${response.status}` })
      continue
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    const cleaned = basename(file.filename).replace(/[\\/:*?"<>|\r\n\0]/g, '_')
    const safeBase = cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `output-${index}`
    const directory = workspace ? await workspaceDirectory(workspace, outputDir) : outputDir
    let target = join(directory, safeBase)
    if (workspace) {
      // Reserve a new filename so a retry cannot overwrite an earlier download or follow a file symlink.
      let suffix = 0
      for (;;) {
        try {
          await writeFile(target, buffer, { flag: 'wx', signal })
          break
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
          target = join(directory, `${++suffix}-${safeBase}`)
        }
      }
    } else {
      if (results.some((result) => result.path === target)) target = join(directory, `${index}-${safeBase}`)
      await writeFile(target, buffer, { signal })
    }
    results.push({ ...file, path: target, bytes: buffer.byteLength })
  }
  return results
}

export function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new ComfyError('操作已取消'))
      return
    }
    const timer = setTimeout(resolvePromise, ms)
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new ComfyError('操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    setTimeout(() => signal?.removeEventListener('abort', onAbort), ms + 10)
  })
}

/**
 * Convert a workflow and return both an API prompt and a compact inspection.
 */
export async function inspectWorkflowFile(baseUrl, workflowName, { signal } = {}) {
  const [workflow, objectInfo] = await Promise.all([
    readComfyWorkflow(baseUrl, workflowName, { signal }),
    getComfyObjectInfo(baseUrl, { signal }),
  ])
  return { workflow, objectInfo, ...(await describeComfyWorkflow(workflow, objectInfo)) }
}
