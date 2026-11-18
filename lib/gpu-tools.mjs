/** GPU catalog tools: inspect available cards and set per-workflow defaults. */

import { defaultGpuSummary, fetchGpuList, resolveGpu } from './gpu.mjs'
import { checkPodUpdate, getPodDetail, cloudId } from './pod-update.mjs'

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '工具返回值不是无损 JSON，已阻止返回。' }
  }
}

export function registerGpuTools(ctx, { api, config, state }) {
  const register = (definition) => {
    const wrapped = {
      ...definition,
      async execute(args, exec) {
        try {
          return toLosslessJson(await definition.execute(args, exec))
        } catch (error) {
          return toLosslessJson({ ok: false, error: String(error?.message ?? error) })
        }
      },
    }
    return ctx.effect(() => ctx.tools.register(wrapped), `chenyu-workflow: gpu tool ${definition.name}`)
  }

  register({
    name: 'chenyu_gpu_list',
    description: '列出晨羽智云平台可选的 GPU 显卡（型号、显存估算、每小时价格、是否可用），以及图片/视频工作流当前设置的默认显卡。生成图片或视频前想选卡时先看这个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    async execute(_args, exec) {
      const [gpus, saved] = await Promise.all([
        fetchGpuList(api, { signal: exec?.signal, force: true }),
        state.get(),
      ])
      return { ok: true, gpus, defaults: defaultGpuSummary(config, saved) }
    },
  })

  register({
    name: 'chenyu_pod_update_check',
    description: '只读检测实例或指定 Pod 的当前镜像版本和最新发布版本。可传 instance_uuid 核对指定实例，或传 pod_uuid 获取该镜像的版本清单。两个参数都省略时检测默认实例。',
    parameters: {
      type: 'object',
      properties: {
        instance_uuid: { type: 'string', description: '要核对的云实例 UUID' },
        pod_uuid: { type: 'string', description: '要读取版本清单的 Pod UUID，与 instance_uuid 二选一' },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      if (args?.instance_uuid && args?.pod_uuid) throw new Error('请选择实例或 Pod 镜像。')
      if (args?.pod_uuid) return { ok: true, pod: await getPodDetail(api, args.pod_uuid, { signal: exec?.signal }) }
      const instanceUuid = args?.instance_uuid ? cloudId(args.instance_uuid, '实例') : undefined
      return checkPodUpdate(api, { state, instanceUuid, signal: exec?.signal })
    },
  })

  register({
    name: 'chenyu_set_default_gpu',
    description: '设置某类工作流的默认显卡：图片（MOSS 文生图）或视频（MiniMax H3 图生视频）。之后不显式传 gpu 的任务会使用它。用户说“以后图片用4080、视频用48G”时调用。',
    parameters: {
      type: 'object',
      properties: {
        workflow_type: { type: 'string', enum: ['image', 'video'], description: '工作流类型：image=图片，video=视频' },
        gpu: { type: 'string', description: '显卡名称或 UUID，例如 RTX 4080、nGPU-48GB、RTX 5090' },
      },
      required: ['workflow_type', 'gpu'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const type = args?.workflow_type === 'video' ? 'video' : 'image'
      const gpu = await resolveGpu(api, args?.gpu, { signal: exec?.signal, requireAvailable: false })
      await state.setDefaultGpu(type, gpu)
      const saved = await state.get()
      return { ok: true, workflow_type: type, gpu, defaults: defaultGpuSummary(config, saved) }
    },
  })
}
