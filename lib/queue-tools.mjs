/** Queue controls plus the two default-workflow shortcuts. */

import { defaultWorkflowSummary } from './job-spec.mjs'
import { prepareSubmission, sessionFor, submitAndWait, targetParameters } from './submit.mjs'

const scope = (exec) => ({ sessionId: String(exec?.agent?.id || '') })

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

function prettifyResult(result, jobId) {
  if (!result) return { ok: true, job_id: jobId }
  return {
    ok: result.status === 'succeeded',
    job_id: result.id || jobId,
    status: result.status,
    timed_out: result.timed_out || undefined,
    workflow_name: result.workflow_name,
    workflow_label: result.workflow_label,
    gpu_name: result.gpu_name || undefined,
    gpu_uuid: result.gpu_uuid || undefined,
    gpu_switched: result.gpu_switched || undefined,
    prompt_id: result.prompt_id,
    outputs: result.downloaded_files,
    output_dir: result.output_dir,
    warnings: result.warnings,
    elapsed_seconds: result.elapsed_seconds,
    error: result.error || undefined,
    shutdown: result.shutdown || undefined,
    job: result,
  }
}

async function submit({ api, queue, args, config, state, ctx, exec, workflowType }) {
  const spec = await prepareSubmission({
    api, state, config, input: { ...args, workflow_type: workflowType },
    ...await sessionFor(ctx, exec), signal: exec?.signal,
  })
  return submitAndWait({ queue, spec, args, signal: exec?.signal })
}

export function registerQueueTools(ctx, { api, config, state, queue }) {
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
    return ctx.effect(() => ctx.tools.register(wrapped), `chenyu-workflow: queue tool ${definition.name}`)
  }

  register({
    name: 'chenyu_image_generate',
    description: '用默认 MOSS 文生图工作流生成图片，不需要指定工作流。任务会进入晨羽 GPU 队列：自动开机 → 排队执行 → 下载图片 → 队列全部完成后自动关机。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '图片提示词（中文/英文均可）' },
        aspect_ratio: { type: 'string', description: '画面比例，例如 16:9、1:1、9:16；不填沿用工作流默认值' },
        megapixels: { type: 'number', description: '分辨率（百万像素），例如 0.8；默认沿用工作流值' },
        seed: { type: 'integer', description: '随机种子；不填沿用工作流值' },
        overrides: { type: 'object', description: '按节点 ID 覆盖参数（高级用法）', additionalProperties: true },
        gpu: { type: 'string', description: '显卡名称或 UUID（如 RTX 4080、nGPU-48GB）；不填使用“图片默认显卡”设置' },
        ...targetParameters,
        output_dir: { type: 'string', description: '输出目录；相对路径按当前会话工作目录解析' },
        wait: { type: 'boolean', description: '是否等待生成完成，默认 true；false 时只入队', default: true },
        wait_timeout_seconds: { type: 'integer', description: '等待上限秒数，默认 3600', default: 3600, minimum: 30, maximum: 7200 },
        timeout_seconds: { type: 'integer', description: '单个工作流执行超时秒数，默认 1800', default: 1800, minimum: 60, maximum: 7200 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      return submit({ api, queue, args, config, state, ctx, exec, workflowType: 'image' })
    },
  })

  register({
    name: 'chenyu_video_generate',
    description: '用默认 MiniMax H3 图生视频工作流生成视频，不需要指定工作流。可传参考图/参考视频/参考音频；任务进入晨羽 GPU 队列，自动开机、排队执行、下载结果，队列全部完成后自动关机。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频提示词/分镜描述（建议按 H3 结构写，或直接描述画面和动作）' },
        duration: { type: 'number', description: '视频时长（秒），1-15，默认沿用工作流值' },
        aspect_ratio: { type: 'string', description: '画面比例，例如 16:9、9:16；不填沿用工作流值' },
        megapixels: { type: 'number', description: '分辨率（百万像素），例如 0.8；不填沿用工作流值' },
        seed: { type: 'integer', description: '随机种子；不填沿用工作流值' },
        reference_images: { type: 'array', items: { type: 'string' }, description: '参考图片本地路径列表，按顺序填入 H3 的 LoadImage 节点（最多 9 张）' },
        reference_videos: { type: 'array', items: { type: 'string' }, description: '参考视频本地路径列表（最多 3 段）' },
        reference_audios: { type: 'array', items: { type: 'string' }, description: '参考音频本地路径列表（最多 3 段）' },
        overrides: { type: 'object', description: '按节点 ID 覆盖参数（高级用法）', additionalProperties: true },
        gpu: { type: 'string', description: '显卡名称或 UUID（如 nGPU-48GB、RTX 5090）；不填使用“视频默认显卡”设置。4080 16GB 跑长视频容易崩，建议选 32GB 以上显存' },
        ...targetParameters,
        output_dir: { type: 'string', description: '输出目录；相对路径按当前会话工作目录解析' },
        wait: { type: 'boolean', description: '是否等待生成完成，默认 true；false 时只入队', default: true },
        wait_timeout_seconds: { type: 'integer', description: '等待上限秒数，默认 3600', default: 3600, minimum: 30, maximum: 7200 },
        timeout_seconds: { type: 'integer', description: '单个工作流执行超时秒数，默认 1800', default: 1800, minimum: 60, maximum: 7200 },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      return submit({ api, queue, args, config, state, ctx, exec, workflowType: 'video' })
    },
  })

  register({
    name: 'chenyu_queue_status',
    description: '查看当前会话的晨羽 GPU 任务、进度、历史和关机回执。可传 job_id 查看单个任务。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID；不填返回队列总览' },
        limit: { type: 'integer', description: '历史记录条数，默认 20', default: 20, minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      if (args?.job_id) {
        const job = await queue.getJob(String(args.job_id), scope(exec))
        if (!job) throw new Error(`当前会话没有任务 ${args.job_id}。`)
        return { ok: true, job, defaults: defaultWorkflowSummary(config) }
      }
      return queue.getSnapshot({ limit: args?.limit, ...scope(exec) })
    },
  })

  register({
    name: 'chenyu_queue_wait',
    description: '等待当前会话的晨羽任务完成。不传 job_id 时等待本会话正在运行或排队的任务。返回输出文件，以及可用的关机回执。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '任务 ID；不填等待当前活动任务' },
        timeout_seconds: { type: 'integer', description: '等待上限秒数，默认 3600', default: 3600, minimum: 30, maximum: 7200 },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      let jobId = args?.job_id ? String(args.job_id) : ''
      if (!jobId) {
        const snapshot = await queue.getSnapshot({ limit: 1, ...scope(exec) })
        jobId = snapshot.active[0]?.id || snapshot.queued[0]?.id || ''
      }
      if (!jobId) return { ok: true, idle: true, message: '队列当前没有任务。' }
      const timeoutMs = Math.max(30, Number(args?.timeout_seconds) || 3600) * 1000
      const result = await queue.waitForJob(jobId, { timeoutMs, signal: exec?.signal, ...scope(exec) })
      return prettifyResult(result, jobId)
    },
  })

  register({
    name: 'chenyu_queue_cancel',
    description: '取消当前会话的晨羽任务。传 job_id 取消单个任务，或 all=true 取消本会话所有排队和运行中的任务。',
    parameters: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: '要取消的任务 ID' },
        all: { type: 'boolean', description: '是否取消队列中所有未结束任务', default: false },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      const session = scope(exec)
      if (args?.all === true) {
        const snapshot = await queue.getSnapshot({ limit: 1, ...session })
        const ids = [...snapshot.queued, ...snapshot.active].map((job) => job.id)
        const jobs = []
        for (const id of ids) jobs.push(await queue.cancel(id, session))
        return { ok: true, cancelled: jobs.length, jobs }
      }
      if (!args?.job_id) throw new Error('请传 job_id，或传 all=true 取消本会话的所有任务。')
      return { ok: true, job: await queue.cancel(String(args.job_id), session) }
    },
  })

  register({
    name: 'chenyu_queue_clear',
    description: '清除当前会话中已经结束的晨羽任务记录。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output,
    async execute(_args, exec) {
      return queue.clearHistory(scope(exec))
    },
  })

  register({
    name: 'chenyu_queue_retry',
    description: '重新提交当前会话已经结束的晨羽任务，使用该任务的镜像版本和参数。重试会重新运行并可能产生费用。',
    parameters: {
      type: 'object',
      properties: { job_id: { type: 'string', description: '要重试的任务 ID' } },
      required: ['job_id'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      return { ok: true, job: await queue.retry(String(args.job_id), scope(exec)) }
    },
  })
}
