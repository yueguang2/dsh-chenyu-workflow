/** Model-facing tools for user-owned Chenyu GPU instances and ComfyUI workflows. */

import { ChenyuApiError } from './api.mjs'
import { defaultWorkflowSummary } from './job-spec.mjs'
import { cloudTarget, prepareSubmission, sessionFor, submitAndWait, targetParameters } from './submit.mjs'
import { ensurePodInstance, listInstances, listSavedPods } from './pod-update.mjs'
import { ComfyError, comfyServiceUrl, createComfyClient, inspectWorkflowFile, listComfyWorkflows, sanitizeInstance } from './comfy.mjs'
import { RUNNING_STATUS, fetchInstance, startAndWait, shutdownAndWait } from './instance-ops.mjs'
import { resolveGpu } from './gpu.mjs'
import { cloudWorkflowName, readWorkflowCatalog, recordWorkflowCatalog } from './workflow-catalog.mjs'

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function errorResult(error) {
  if (error instanceof ChenyuApiError) {
    return {
      ok: false,
      error: error.message,
      status: error.status || undefined,
      code: error.code || undefined,
      detail: error.detail || undefined,
    }
  }
  if (error instanceof ComfyError) {
    return { ok: false, error: error.message, status: error.status || undefined, detail: error.payload }
  }
  return { ok: false, error: String(error?.message ?? error) }
}

function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '工具返回值不是无损 JSON，已阻止返回。' }
  }
}

function resolveInstanceUuid(args, state) {
  return cloudTarget(args || {}).instanceUuid || state.getDefaultInstanceUuid()
}

export function registerInstanceTools(ctx, { api, config, state, queue }) {
  async function readCatalog(args, exec, workflowName) {
    const signal = exec?.signal
    const source = cloudTarget(args)
    if (!source.podUuid && !source.instanceUuid) source.instanceUuid = await state.getDefaultInstanceUuid()
    const catalog = await readWorkflowCatalog(api, { state, ...source, signal, workflowName })
    const format = (value) => {
      const { inspection, workflows, ...details } = value
      if (workflowName) {
        if (!inspection) throw new Error('工作流参数需要读取当前镜像。可明确要求开机读取（计费），或直接按文件名提交。')
        const { workflow, objectInfo, ...description } = inspection
        return { ...details, workflow_name: workflowName, ...description }
      }
      return { ...details, workflows: workflows.map(({ name }) => name), defaults: defaultWorkflowSummary(config) }
    }
    if (catalog.source === 'live' || args.start_if_needed !== true) return format(catalog)

    const spec = await prepareSubmission({
      api, config, state, input: { ...args, workflow_type: 'image' },
      sessionId: String(exec?.agent?.id || ''), signal, kind: 'scan',
    })
    return queue.withIdleQueue(async () => {
      let uuid = spec.instance_uuid
      let ownsInstance = false
      const track = async (id) => {
        ownsInstance = true
        await queue.trackInstance(id, spec.session_id)
      }
      try {
        if (spec.pod_uuid) {
          const target = await ensurePodInstance(api, {
            state, podUuid: spec.pod_uuid, tag: spec.pod_tag, gpuUuid: spec.gpu_uuid, gpuNums: spec.gpu_nums, signal,
            ownsInstance: () => false,
          })
          uuid = target.instanceUuid
          if (target.created) await track(uuid)
          await state.rememberPodInstance(spec.pod_uuid, spec.pod_tag, uuid)
        }
        const { info, comfyUrl } = await startAndWait(api, uuid, {
          signal, gpuUuid: spec.gpu_uuid, gpuNums: spec.gpu_nums, gpuName: spec.gpu_name, waitComfy: args.wait_comfy !== false,
          expectedPodUuid: spec.pod_uuid || spec.expected_pod_uuid, expectedImageTag: spec.pod_tag || spec.expected_image_tag,
          onInstanceUse: async (id, { owned }) => {
            if (owned) await track(id)
            return ownsInstance
          },
        })
        const files = await listComfyWorkflows(comfyUrl, { signal })
        const directory = await recordWorkflowCatalog(state, { ...info, instance_uuid: uuid }, files)
        const inspection = workflowName ? await inspectWorkflowFile(comfyUrl, workflowName, { signal }) : undefined
        return format({ ok: true, source: 'live', ...directory, started_instance: ownsInstance, inspection })
      } finally {
        // The queue retains the lease when a shutdown receipt is unavailable.
        if (ownsInstance) {
          await shutdownAndWait(api, uuid, { waitForStartup: true })
          await queue.forgetInstance(uuid)
        }
      }
    })
  }

  const register = (definition) => {
    const wrapped = {
      ...definition,
      async execute(args, exec) {
        try {
          return toLosslessJson(await definition.execute(args, exec))
        } catch (error) {
          return toLosslessJson(errorResult(error))
        }
      },
    }
    return ctx.effect(
      () => ctx.tools.register(wrapped),
      `chenyu-workflow: instance tool ${definition.name}`,
    )
  }

  register({
    name: 'chenyu_instance_list',
    description: '只读列出晨羽账号下的 GPU 实例、镜像版本和已保存的 Pod 镜像。可用实例 UUID 运行现有实例，也可用 Pod UUID 和版本按需创建。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    async execute(_args, exec) {
      const signal = exec?.signal
      const [instances, defaultInstanceUuid] = await Promise.all([listInstances(api, { signal }), state.getDefaultInstanceUuid()])
      const pods = await listSavedPods(api, { state, instances, signal })
      return { ok: true, total: instances.length, default_instance_uuid: defaultInstanceUuid || null,
        instances: instances.map((item) => sanitizeInstance(item)), pods }
    },
  })

  register({
    name: 'chenyu_instance_status',
    description: '查询单个晨羽智云 GPU 实例的实时状态、GPU 信息、ComfyUI 服务地址和（运行中时）ComfyUI 是否就绪。只读，不会开机或关机。',
    parameters: {
      type: 'object',
      properties: {
        instance_uuid: { type: 'string', description: '实例 UUID；不填则用设置页的默认实例' },
        check_comfy: { type: 'boolean', description: '是否探测 ComfyUI /system_stats，默认 true', default: true },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const instanceUuid = await resolveInstanceUuid(args, state)
      if (!instanceUuid) throw new Error('没有指定 instance_uuid，且设置页没有保存默认实例。')
      const info = await fetchInstance(api, instanceUuid, exec?.signal)
      const result = { ok: true, ...sanitizeInstance(info) }
      if (Number(info.status) === RUNNING_STATUS && args?.check_comfy !== false) {
        const comfyUrl = comfyServiceUrl(info)
        if (comfyUrl) {
          try {
            const client = createComfyClient(comfyUrl, { defaultTimeoutMs: 8_000 })
            const stats = await client.get('/system_stats', { signal: exec?.signal })
            result.comfy = { url: comfyUrl, ready: true, version: stats?.system?.comfyui_version }
          } catch (error) {
            result.comfy = { url: comfyUrl, ready: false, error: String(error?.message ?? error) }
          }
        }
      }
      return result
    },
  })

  register({
    name: 'chenyu_instance_start',
    description: '给指定晨羽智云 GPU 实例开机，并等待实例进入“运行中”以及 ComfyUI 就绪。可传 gpu 选择显卡（如 RTX 4080、nGPU-48GB）；不传则按实例当前显卡开机。注意：开机按小时计费，用完后应调用 chenyu_instance_shutdown。',
    parameters: {
      type: 'object',
      properties: {
        instance_uuid: { type: 'string', description: '实例 UUID；不填则用设置页的默认实例' },
        gpu: { type: 'string', description: '开机使用的显卡名称或 UUID（如 RTX 4080、nGPU-48GB）；不填沿用实例当前显卡' },
        gpu_nums: { type: 'integer', description: 'GPU 数量，默认沿用实例当前数量', minimum: 1, maximum: 8 },
        timeout_seconds: { type: 'integer', description: '等待开机的上限秒数，默认 420', default: 420, minimum: 30, maximum: 1800 },
        wait_comfy: { type: 'boolean', description: '是否等待 ComfyUI WebUI 就绪，默认 true', default: true },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const instanceUuid = await resolveInstanceUuid(args, state)
      if (!instanceUuid) throw new Error('没有指定 instance_uuid，且设置页没有保存默认实例。')
      const result = await queue.withIdleQueue(async () => {
        const signal = exec?.signal
        const current = args?.gpu ? await fetchInstance(api, instanceUuid, signal) : null
        const gpu = args?.gpu ? await resolveGpu(api, args.gpu, {
          signal, currentGpuUuid: Number(current?.status) === RUNNING_STATUS ? current.gpu_uuid : '',
        }) : null
        const result = await startAndWait(api, instanceUuid, {
          gpuUuid: gpu?.gpu_uuid || '',
          gpuNums: Number(args?.gpu_nums) || 0,
          gpuName: gpu?.gpu_name || '',
          timeoutMs: Math.max(30, Number(args?.timeout_seconds) || 420) * 1000,
          waitComfy: args?.wait_comfy !== false,
          signal,
          onInstanceUse: async (id, { owned }) => {
            if (owned) await queue.trackInstance(id)
            return true
          },
        })
        await queue.forgetInstance(instanceUuid)
        return result
      })
      return {
        ok: true,
        instance_uuid: instanceUuid,
        started: result.started,
        gpu_switched: result.gpu_switched === true,
        ...sanitizeInstance(result.info),
        comfy_url: result.comfyUrl,
      }
    },
  })

  register({
    name: 'chenyu_instance_shutdown',
    description: '关闭指定晨羽 GPU 实例并确认状态。运行中任务须先取消或等完成；force=true 允许在只有待执行任务时手动关机。',
    parameters: {
      type: 'object',
      properties: {
        instance_uuid: { type: 'string', description: '实例 UUID；不填则用设置页的默认实例' },
        timeout_seconds: { type: 'integer', description: '等待关机的上限秒数，默认 120', default: 120, minimum: 15, maximum: 600 },
        force: { type: 'boolean', description: '队列还有任务时是否强制关机，默认 false', default: false },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const instanceUuid = await resolveInstanceUuid(args, state)
      if (!instanceUuid) throw new Error('没有指定 instance_uuid，且设置页没有保存默认实例。')
      return queue.withIdleQueue(async () => {
        const result = await shutdownAndWait(api, instanceUuid, {
          timeoutMs: Math.max(15, Number(args?.timeout_seconds) || 120) * 1000,
        })
        await queue.forgetInstance(instanceUuid)
        return { ...result, instance_uuid: instanceUuid }
      }, { allowQueued: args?.force === true })
    },
  })

  register({
    name: 'chenyu_instance_workflows',
    description: '读取指定 Pod 版本或现有实例的 ComfyUI workflows 目录。默认读取实时目录或该版本缓存。明确指定 start_if_needed=true 时可计费开机读取，读完关闭本次启动的实例。',
    parameters: {
      type: 'object',
      properties: {
        ...targetParameters,
        gpu: { type: 'string', description: '本次开机使用的显卡名称或 UUID' },
        start_if_needed: { type: 'boolean', description: '是否允许计费开机读取，默认 false', default: false },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      return readCatalog(args || {}, exec)
    },
  })

  register({
    name: 'chenyu_instance_workflow_inspect',
    description: '读取指定 Pod 版本或现有实例中的某个 ComfyUI 工作流，返回可改的节点 ID 和参数名。实例未开机时，只有显式指定 start_if_needed=true 才计费开机，读完关闭本次启动的实例。',
    parameters: {
      type: 'object',
      properties: {
        ...targetParameters,
        workflow_name: { type: 'string', description: '镜像 workflows 目录中的准确文件名或相对路径' },
        gpu: { type: 'string', description: '本次开机使用的显卡名称或 UUID' },
        start_if_needed: { type: 'boolean', description: '是否允许计费开机读取，默认 false', default: false },
        wait_comfy: { type: 'boolean', description: '是否等待 ComfyUI 就绪，默认 true', default: true },
      },
      required: ['workflow_name'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      return readCatalog(args, exec, cloudWorkflowName(args.workflow_name))
    },
  })

  register({
    name: 'chenyu_instance_workflow_run',
    description: '运行 Pod 镜像或现有实例中的 ComfyUI 工作流。指定 Pod UUID 和版本时会复用或创建对应实例。队列按需开机、串行执行、下载并自动关机。workflow_name 可用准确文件名、MOSS 或 H3。也支持本地/API 格式的工作流。',
    parameters: {
      type: 'object',
      properties: {
        ...targetParameters,
        gpu: { type: 'string', description: '显卡名称或 UUID（如 RTX 4080、nGPU-48GB）；不填使用该工作流类型的默认显卡' },
        gpu_nums: { type: 'integer', description: 'GPU 数量；不填沿用已有实例数量或使用 1 张', minimum: 1, maximum: 8 },
        workflow_type: { type: 'string', enum: ['auto', 'image', 'video'], description: '未指定具体工作流时选默认工作流：auto 根据文件和提示词判断，默认 auto', default: 'auto' },
        workflow_name: { type: 'string', description: '所选镜像 workflows 目录下的准确文件名或相对路径，也可用 MOSS、H3 别名' },
        workflow_file: { type: 'string', description: '本地 ComfyUI 工作流 JSON 文件路径，与 workflow_name、workflow_json 三选一' },
        workflow_json: { type: 'object', description: '直接传 ComfyUI 工作流对象，与 workflow_name、workflow_file 三选一', additionalProperties: true },
        prompt: { type: 'string', description: '提示词。能唯一匹配时自动写入，也可用 prompt_node 和 prompt_input 指定节点' },
        prompt_node: { type: 'string', description: '提示词节点 ID' },
        prompt_input: { type: 'string', description: '提示词输入名' },
        seed: { type: 'integer', description: '随机种子' },
        megapixels: { type: 'number', description: '分辨率（百万像素）' },
        aspect_ratio: { type: 'string', description: '画面比例，例如 16:9' },
        duration: { type: 'number', description: '视频时长（秒）' },
        reference_images: { type: 'array', maxItems: 9, items: { type: 'string' }, description: '参考图片本地路径' },
        reference_videos: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '参考视频本地路径' },
        reference_audios: { type: 'array', maxItems: 3, items: { type: 'string' }, description: '参考音频本地路径' },
        overrides: {
          type: 'object',
          description: '按节点 ID 覆盖参数，例如 {"88":{"value":"提示词"},"259":{"value":5}}；可先用 chenyu_instance_workflow_inspect 查看节点和参数名。',
          additionalProperties: true,
        },
        files: {
          type: 'object',
          description: '按节点 ID 上传本地参考文件，例如 {"49":"/path/ref.jpg"}；也可写 {"49":{"path":"/path/ref.jpg","input":"image"}}。适用于 LoadImage/VHS_LoadVideo/LoadAudio 节点。',
          additionalProperties: true,
        },
        output_dir: { type: 'string', description: '输出目录；相对路径按当前会话工作目录解析，默认 generated/chenyu/instance/<实例UUID>/<时间>' },
        wait: { type: 'boolean', description: '是否等待任务完成，默认 true；false 时只入队并立即返回 job_id', default: true },
        wait_timeout_seconds: { type: 'integer', description: '等待任务完成的上限秒数，默认 3600', default: 3600, minimum: 30, maximum: 7200 },
        timeout_seconds: { type: 'integer', description: '单个工作流执行超时秒数，默认 1800', default: 1800, minimum: 60, maximum: 7200 },
        start_if_needed: { type: 'boolean', description: '兼容旧参数；队列模式始终按需开机', default: true },
        shutdown_after: { type: 'boolean', description: '兼容旧参数；队列模式始终在全部任务结束后自动关机', default: true },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      if (!queue) throw new Error('队列服务未初始化。')
      const spec = await prepareSubmission({
        api, state, config, input: args || {},
        ...await sessionFor(ctx, exec), signal: exec?.signal,
      })
      return submitAndWait({ queue, spec, args, signal: exec?.signal })
    },
  })
}
