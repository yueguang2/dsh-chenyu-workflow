/** Execute one queued Chenyu/ComfyUI workflow job (no queue policy here). */

import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import {
  ComfyError,
  collectComfyOutputFiles,
  createComfyClient,
  downloadComfyOutputFiles,
  getComfyObjectInfo,
  listComfyWorkflows,
  normalizePromptComboValues,
  readComfyWorkflow,
  sleep,
  submitComfyPrompt,
  uploadWorkflowFiles,
  waitForComfyPrompt,
  watchComfyPromptProgress,
} from './comfy.mjs'
import { DEFAULT_CONFIG } from './config.mjs'
import { CONSTANTS } from './constants.mjs'
import { isTransientError } from './error-messages.mjs'
import { startAndWait } from './instance-ops.mjs'
import { prepareWorkflow, resolveInstanceWorkflow } from './workflow-adapt.mjs'
import { workspaceDirectory, workspaceFile } from './workspace.mjs'

const PHASE_PROGRESS = {
  starting_instance: 3,
  switching_gpu: 4,
  waiting_shutdown: 2,
  waiting_comfy: 10,
  preparing_workflow: 16,
  uploading_files: 20,
  submitting: 25,
  running: 30,
  downloading: 91,
  succeeded: 100,
}

async function loadWorkflow(job, comfyUrl, objectInfo, config, signal, onCatalog, catalogNames) {
  if (job.workflow_json && typeof job.workflow_json === 'object') {
    return { workflow: job.workflow_json, source: 'workflow_json', name: null, warnings: [] }
  }
  if (job.workflow_file) {
    const path = job.workspace_only
      ? await workspaceFile(job.base_dir, job.workflow_file, '本地工作流') : job.workflow_file
    const text = await readFile(path, { encoding: 'utf8', signal })
    return { workflow: JSON.parse(text), source: `file:${job.workflow_file}`, name: null, warnings: [] }
  }
  if (!job.workflow_name) throw new ComfyError('任务没有指定工作流。')
  const loaded = await resolveInstanceWorkflow(job, {
    read: (name) => readComfyWorkflow(comfyUrl, name, { signal }),
    list: async () => {
      if (catalogNames) return catalogNames
      const names = await listComfyWorkflows(comfyUrl, { signal })
      await onCatalog?.(names)
      return names
    },
    objectInfo,
    config,
  })
  return { ...loaded, source: `instance:${loaded.name}` }
}

function isTransientComfyError(error) {
  return error instanceof ComfyError && ([502, 503, 504].includes(error.status)
    || /服务暂未就绪|尚未就绪/i.test(error.message) || isTransientError(error))
}

async function withComfyRetry(fn, { signal, onTick }) {
  const deadline = Date.now() + 240_000
  for (;;) {
    signal?.throwIfAborted()
    try {
      return await fn()
    } catch (error) {
      if (!isTransientComfyError(error) || Date.now() >= deadline) throw error
      onTick(error)
      await sleep(3_000, signal)
    }
  }
}

/** Run one workflow job. The caller owns queue state and instance shutdown. */
export async function runWorkflowJob({ api, config, job, signal, onProgress, onInstanceUse, onWorkflowCatalog }) {
  const startedAt = Date.now()
  const baseDir = job.base_dir || process.cwd()
  const outputDir = job.output_dir
    ? resolve(baseDir, String(job.output_dir))
    : resolve(baseDir, config.outputDir || DEFAULT_CONFIG.outputDir, 'instance', job.instance_uuid, new Date().toISOString().replace(/[:.]/g, '-'))
  if (job.workspace_only) {
    await workspaceDirectory(baseDir, outputDir)
    const references = [
      ...(job.reference_images || []), ...(job.reference_videos || []), ...(job.reference_audios || []),
      ...Object.values(job.files || {}).map((file) => typeof file === 'string' ? file : file.path),
    ]
    await Promise.all([
      ...references.map((path) => workspaceFile(baseDir, path, '参考文件')),
      job.workflow_file && workspaceFile(baseDir, job.workflow_file, '本地工作流'),
    ])
  }
  const progress = (patch) => onProgress?.({
    ...patch,
    updated_at: new Date().toISOString(),
    elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
  })

  progress({ phase: 'starting_instance', phase_label: '正在准备 GPU 实例', progress: PHASE_PROGRESS.starting_instance, progress_detail: job.gpu_name ? `目标显卡：${job.gpu_name}` : '检查实例状态' })
  const started = await startAndWait(api, job.instance_uuid, {
    gpuUuid: job.gpu_uuid || '',
    gpuNums: job.gpu_nums || 0,
    gpuName: job.gpu_name || '',
    signal,
    onInstanceUse,
    expectedImageTag: job.pod_tag || job.expected_image_tag,
    expectedPodUuid: job.pod_uuid || job.expected_pod_uuid,
    onPhase: (phase, label) => progress({
      phase,
      phase_label: label,
      progress: PHASE_PROGRESS[phase] ?? 5,
      progress_detail: phase === 'waiting_comfy' ? '实例已开机，等待 ComfyUI 服务就绪' : label,
    }),
    onComfyTick: ({ elapsed_ms, last_error }) => progress({
      phase: 'waiting_comfy',
      phase_label: '等待 ComfyUI 就绪',
      progress: PHASE_PROGRESS.waiting_comfy,
      progress_detail: `实例运行中，等待 ComfyUI 服务响应（已等待 ${Math.round((elapsed_ms || 0) / 1000)} 秒${last_error ? '，服务仍在启动' : ''}）`,
    }),
  })
  const comfyUrl = started.comfyUrl
  const currentName = job.workflow_label || job.workflow_name || (job.workflow_file && basename(job.workflow_file)) || 'ComfyUI 工作流'
  progress({ phase: 'preparing_workflow', phase_label: '准备工作流', progress: PHASE_PROGRESS.preparing_workflow, progress_detail: `读取 ${currentName}`, comfy_url: comfyUrl })
  const retryOptions = {
    signal,
    onTick: (error) => progress({ phase: 'preparing_workflow', phase_label: '等待 ComfyUI 就绪', progress: PHASE_PROGRESS.preparing_workflow, progress_detail: `ComfyUI 服务仍在启动：${error.message}` }),
  }
  const catalogSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
  const saveCatalog = onWorkflowCatalog && ((names) => onWorkflowCatalog(started.info, names))
  const catalog = saveCatalog && listComfyWorkflows(comfyUrl, { signal: catalogSignal })
    .then(async (names) => {
      await saveCatalog(names)
      return names
    }).catch(() => null)
  const [objectInfo, names] = await Promise.all([
    withComfyRetry(() => getComfyObjectInfo(comfyUrl, { signal, fresh: true }), retryOptions), catalog,
  ])
  const loaded = await withComfyRetry(() => loadWorkflow(job, comfyUrl, objectInfo, config, signal, saveCatalog, names), retryOptions)
  progress({
    phase: 'preparing_workflow', phase_label: '适配工作流', progress: PHASE_PROGRESS.preparing_workflow,
    progress_detail: `验证 ${loaded.name || currentName} 的节点与输入`,
    resolved_workflow_name: loaded.name, workflow_source: loaded.source,
  })
  const { prompt, promptTarget, files, warnings: preparationWarnings } = prepareWorkflow(loaded.workflow, objectInfo, job, { config })
  const warnings = [...loaded.warnings, ...preparationWarnings]
  const normalized = normalizePromptComboValues(prompt, objectInfo)
  warnings.push(...normalized.warnings)

  let uploaded = []
  if (Object.keys(files).length) {
    progress({ phase: 'uploading_files', phase_label: '上传参考文件', progress: PHASE_PROGRESS.uploading_files, progress_detail: '准备参考图/视频/音频' })
    uploaded = await uploadWorkflowFiles(createComfyClient(comfyUrl), prompt, files, { signal, baseDir, workspaceOnly: job.workspace_only })
  }

  progress({ phase: 'submitting', phase_label: '提交工作流', progress: PHASE_PROGRESS.submitting, progress_detail: '等待 ComfyUI 接收任务' })
  const clientId = `dsh-${job.id || Date.now()}`
  signal?.throwIfAborted()
  // An in-flight POST may already have enqueued the prompt. Keep its receipt so
  // cancellation can target that prompt; never retry a submission with unknown outcome.
  const submission = await submitComfyPrompt(comfyUrl, prompt, { clientId })
  const promptId = submission.prompt_id
  progress({ phase: 'running', phase_label: '生成中', progress: PHASE_PROGRESS.running, progress_detail: '已提交，等待 ComfyUI 执行', prompt_id: promptId, comfy_url: comfyUrl })
  signal?.throwIfAborted()
  if (Object.keys(submission.node_errors || {}).length) warnings.push('ComfyUI 接收了任务，但部分输出分支未通过校验。')

  const stopProgress = watchComfyPromptProgress(comfyUrl, promptId, {
    clientId,
    onProgress: (event) => {
      if (event?.type === 'progress') {
        const fraction = Math.max(0, Math.min(1, event.value / event.max))
        progress({ phase: 'running', phase_label: '生成中', progress: 30 + Math.round(fraction * 55), progress_detail: `第 ${event.value}/${event.max} 步` })
      } else if (event?.type === 'execution_start') {
        progress({ phase: 'running', phase_label: '生成中', progress: 31, progress_detail: '工作流开始执行' })
      }
    },
  })
  let waited
  try {
    waited = await waitForComfyPrompt(comfyUrl, promptId, {
      timeoutMs: Math.max(60, Number(job.timeout_seconds) || 1800) * 1000,
      signal,
    })
  } finally {
    stopProgress()
  }

  if (!waited?.ok) {
    const messages = Array.isArray(waited?.history?.status?.messages) ? waited.history.status.messages : []
    throw new ComfyError(`ComfyUI 工作流执行失败：${JSON.stringify(messages.slice(-2)).slice(0, 1200)}`, { payload: waited?.history?.status })
  }

  const outputFiles = collectComfyOutputFiles(waited.history)
  if (outputFiles.length === 0) warnings.push('工作流执行成功，但没有发现可下载的输出文件（检查工作流里是否有 SaveImage / VHS_VideoCombine 等输出节点）。')
  progress({ phase: 'downloading', phase_label: '下载结果', progress: PHASE_PROGRESS.downloading, progress_detail: `发现 ${outputFiles.length} 个输出文件` })
  const workspace = job.workspace_only ? baseDir : undefined
  const localOutputDir = workspace ? await workspaceDirectory(workspace, outputDir) : outputDir
  const downloaded = await downloadComfyOutputFiles(comfyUrl, outputFiles, localOutputDir, { signal, workspace })

  progress({ phase: 'succeeded', phase_label: '已完成', progress: 100, progress_detail: `下载 ${downloaded.length} 个文件` })
  return {
    ok: true,
    instance_uuid: job.instance_uuid,
    gpu_uuid: job.gpu_uuid || started.info?.gpu_uuid || '',
    gpu_name: job.gpu_name || started.info?.gpu_name || '',
    workflow_name: loaded.name,
    workflow_source: loaded.source,
    prompt_id: promptId,
    status: waited.status,
    started_instance: started.started,
    gpu_switched: started.gpu_switched === true,
    comfy_url: comfyUrl,
    prompt_target: promptTarget,
    uploaded_files: uploaded,
    outputs_found: outputFiles.length,
    downloaded_files: downloaded,
    output_dir: localOutputDir,
    warnings,
    elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
  }
}
