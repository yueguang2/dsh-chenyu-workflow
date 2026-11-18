/** Normalize and validate a submission shared by the Web UI and model-facing tools. */

import { buildJobSpec } from './job-spec.mjs'
import { inferWorkflowType } from './defaults.mjs'
import { resolveWorkflowGpu } from './gpu.mjs'
import { cloudId, findPodInstance, getPodDetail, listInstances } from './pod-update.mjs'
import { cloudWorkflowName } from './workflow-catalog.mjs'
import { fetchInstance, RUNNING_STATUS } from './instance-ops.mjs'

export const targetParameters = {
  instance_uuid: { type: 'string', description: '现有实例 UUID。与 Pod 镜像二选一，两者均省略时用默认实例' },
  pod_uuid: { type: 'string', description: '云端 Pod 镜像 UUID，需同时提供 pod_tag' },
  pod_tag: { type: 'string', description: 'Pod 版本名（大小写与晨羽一致）。可先调用 chenyu_pod_update_check 查询版本' },
}

export async function sessionFor(ctx, exec) {
  const agent = exec?.agent
  const directories = ctx.get('workingDirectory')
  return {
    sessionId: String(agent?.id || ''),
    baseDir: agent ? await directories.ensure(agent, exec.signal) : process.cwd(),
  }
}

export function cloudTarget(input) {
  if (input.instance_uuid && (input.pod_uuid || input.pod_tag)) throw new Error('实例和 Pod 镜像只能选一种。')
  if (input.pod_uuid || input.pod_tag) {
    const podUuid = cloudId(input.pod_uuid, 'Pod')
    const tag = typeof input.pod_tag === 'string' ? input.pod_tag.trim() : ''
    if (!tag || tag.length > 120) throw new Error('请选择 Pod 镜像的具体版本。')
    return { podUuid, podTag: tag }
  }
  return input.instance_uuid ? { instanceUuid: cloudId(input.instance_uuid, '实例') } : {}
}

export async function prepareSubmission({ api, state, config, input, sessionId, baseDir, signal, kind = 'run' }) {
  const source = cloudTarget(input)
  const instanceUuid = source.instanceUuid || (!source.podUuid && await state.getDefaultInstanceUuid()) || ''
  if (!source.podUuid && !instanceUuid) throw new Error('请选择云端实例或一个 Pod 镜像版本。')
  let info = instanceUuid ? await fetchInstance(api, instanceUuid, signal) : null
  if (source.podUuid) {
    const [pod, instances, saved] = await Promise.all([
      getPodDetail(api, source.podUuid, { signal }), listInstances(api, { signal }), state.get(),
    ])
    if (!pod.versions.some((entry) => entry.version_name === source.podTag)) {
      throw new Error(`此 Pod 没有版本 ${source.podTag}，请刷新镜像列表。`)
    }
    info = findPodInstance(instances, saved, source.podUuid, source.podTag)
  } else if ((input.expected_image_tag && input.expected_image_tag !== info?.image_tag)
    || (input.expected_pod_uuid && input.expected_pod_uuid !== info?.pod_uuid)) {
    throw new Error('实例镜像版本已变化，请刷新工作流目录后重新提交。')
  }
  const workflowType = inferWorkflowType(input)
  const currentGpuUuid = Number(info?.status) === RUNNING_STATUS ? info.gpu_uuid : ''
  const gpu = currentGpuUuid && (!input.gpu || input.gpu === currentGpuUuid)
    ? { gpu_uuid: currentGpuUuid, gpu_name: info.gpu_name }
    : await resolveWorkflowGpu(api, { config, state, workflowType, gpu: input.gpu }, { signal, currentGpuUuid })
  if (source.podUuid && !gpu) throw new Error('请选择要用于此镜像的显卡。')
  const target = {
    instance_uuid: instanceUuid,
    ...(!source.podUuid && info?.image_tag ? { expected_image_tag: info.image_tag } : {}),
    ...(!source.podUuid && info?.pod_uuid ? { expected_pod_uuid: info.pod_uuid } : {}),
    ...(source.podUuid ? { pod_uuid: source.podUuid, pod_tag: source.podTag } : {}),
    session_id: sessionId || '',
    request_id: input.request_id || '',
    gpu_uuid: gpu?.gpu_uuid || '',
    gpu_name: gpu?.gpu_name || '',
    gpu_nums: Number(input.gpu_nums) || Number(info?.gpu_nums) || 1,
    kind,
    base_dir: baseDir,
    workspace_only: input.workspace_only === true,
  }
  if (kind === 'scan') return { ...target, workflow_label: '读取镜像工作流目录', timeout_seconds: 420 }
  const workflowName = input.workflow_name ? cloudWorkflowName(input.workflow_name) : undefined
  const spec = buildJobSpec({ ...input, workflow_name: workflowName, ...target }, { config, baseDir })
  return { ...spec, ...target }
}

export async function submitAndWait({ queue, spec, args, signal }) {
  const job = await queue.enqueue(spec)
  if (args?.wait === false) {
    return { ok: true, queued: true, job_id: job.id, status: job.status, queue_position: job.queue_position, job }
  }
  const waitSeconds = Math.max(30, Number(args?.wait_timeout_seconds) || 3600)
  const result = await queue.waitForJob(job.id, { timeoutMs: waitSeconds * 1000, signal, sessionId: spec.session_id })
  return {
    ok: result.status === 'succeeded',
    job_id: result.id,
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
