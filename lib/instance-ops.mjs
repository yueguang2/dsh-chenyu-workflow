/** Shared Chenyu instance lifecycle helpers used by tools and the queue. */

import { instanceStatusName, waitForComfyReady, comfyServiceUrl, sleep } from './comfy.mjs'

export const RUNNING_STATUS = 2
export const STOPPED_STATUSES = new Set([4, 22, 23])
const STARTING_STATUSES = new Set([1, 24, 27])
const STOPPING_STATUSES = new Set([3, 21])

export function fetchInstance(api, instanceUuid, signal) {
  return api.get('/instance/info', { query: { instance_uuid: instanceUuid }, signal })
}

export async function waitForInstanceStatus(api, instanceUuid, targetStatuses, { timeoutMs = 360_000, intervalMs = 4_000, signal } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  do {
    signal?.throwIfAborted()
    last = await fetchInstance(api, instanceUuid, signal)
    if (targetStatuses.has(Number(last?.status))) return last
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal)
  } while (Date.now() < deadline)
  throw new Error(`等待实例状态超时（最后状态：${instanceStatusName(last?.status)}）。`)
}

/** Start on the selected GPU. The queue may switch GPUs only on an instance it started. */
export async function startAndWait(api, instanceUuid, {
  gpuUuid = '', gpuNums = 0, gpuName = '', timeoutMs = 420_000, signal,
  waitComfy = true, onPhase, onComfyTick, onInstanceUse, expectedImageTag, expectedPodUuid,
} = {}) {
  const verifyImage = (info) => {
    if ((expectedImageTag && info?.image_tag !== expectedImageTag)
      || (expectedPodUuid && info?.pod_uuid !== expectedPodUuid)) {
      throw new Error('实例镜像或版本已变化，请刷新工作流目录后重新提交。')
    }
  }
  let info = await fetchInstance(api, instanceUuid, signal)
  verifyImage(info)
  let status = Number(info?.status)
  if (STARTING_STATUSES.has(status)) {
    onPhase?.('starting_instance', '等待实例完成开机')
    info = await waitForInstanceStatus(api, instanceUuid, new Set([RUNNING_STATUS, 0, ...STOPPED_STATUSES]), { timeoutMs, signal })
    status = Number(info?.status)
  }
  if (STOPPING_STATUSES.has(status)) {
    onPhase?.('waiting_shutdown', '等待实例完成关机')
    info = await waitForInstanceStatus(api, instanceUuid, STOPPED_STATUSES, { timeoutMs: 120_000, signal })
    status = Number(info?.status)
  }

  verifyImage(info)
  const initialStatus = status
  const desiredGpu = String(gpuUuid || info?.gpu_uuid || '').trim()
  const desiredNums = Math.max(1, Number(gpuNums) || Number(info?.gpu_nums) || 1)
  const gpuMismatch = (instance) => (desiredGpu && desiredGpu !== instance?.gpu_uuid)
    || desiredNums !== (Number(instance?.gpu_nums) || 1)
  const gpuSwitched = status === RUNNING_STATUS && Boolean(gpuMismatch(info))
  let started = false

  if (status === RUNNING_STATUS) {
    const owned = await onInstanceUse?.(instanceUuid, { owned: false })
    if (gpuSwitched) {
      if (onInstanceUse && owned !== true) {
        throw new Error(`实例正在使用 ${info.gpu_name || info.gpu_uuid}。请选当前显卡，或先在晨羽结束实例上的其他工作。`)
      }
      const from = info.gpu_name || info.gpu_uuid
      onPhase?.('switching_gpu', `正在切换显卡：${from} → ${gpuName || desiredGpu}`)
      await shutdownAndWait(api, instanceUuid, { timeoutMs: 120_000 })
      info = await fetchInstance(api, instanceUuid, signal)
      verifyImage(info)
      status = Number(info.status)
      if (!STOPPED_STATUSES.has(status) && status !== 0) throw new Error('实例已再次改变状态，请重新选择显卡提交。')
    }
  }

  if (status !== RUNNING_STATUS) {
    if (status !== 0 && !STOPPED_STATUSES.has(status)) {
      throw new Error(`实例当前为“${instanceStatusName(status)}”，无法开机。`)
    }
    signal?.throwIfAborted()
    await onInstanceUse?.(instanceUuid, { owned: true })
    onPhase?.('starting_instance', '正在按所选显卡开机')
    const body = { instance_uuid: instanceUuid, gpu_nums: desiredNums }
    if (desiredGpu) body.gpu_uuid = desiredGpu
    // Receive the startup acknowledgement even if the UI cancels while it is in flight.
    // The queue has already recorded ownership and will close the instance if startup took effect.
    await api.post('/instance/startup', body)
    started = true
    info = await waitForInstanceStatus(api, instanceUuid, new Set([RUNNING_STATUS]), { timeoutMs, signal })
    if (gpuMismatch(info)) {
      throw new Error(`实例启动后的显卡为 ${info.gpu_name || info.gpu_uuid} × ${info.gpu_nums || 1}，与请求的 ${gpuName || desiredGpu} × ${desiredNums} 不一致。`)
    }
  }

  verifyImage(info)
  const comfyUrl = comfyServiceUrl(info)
  if (!comfyUrl && waitComfy) throw new Error('实例没有可用的 WebUI/ComfyUI 服务地址。')
  if (waitComfy) {
    onPhase?.('waiting_comfy', '等待 ComfyUI 就绪')
    await waitForComfyReady(comfyUrl, { timeoutMs: 420_000, signal, onTick: onComfyTick })
    if (expectedImageTag || expectedPodUuid) {
      info = await fetchInstance(api, instanceUuid, signal)
      verifyImage(info)
      if (Number(info.status) !== RUNNING_STATUS || comfyServiceUrl(info) !== comfyUrl || gpuMismatch(info)) {
        throw new Error('ComfyUI 就绪后发现实例配置已变化，请刷新来源后重新提交。')
      }
    }
  }
  return { info, comfyUrl, started, initialStatus, gpu_switched: gpuSwitched }
}

export async function shutdownAndWait(api, instanceUuid, { timeoutMs = 120_000, onPhase, waitForStartup = false } = {}) {
  onPhase?.('shutting_down', '正在关机')
  let info = await fetchInstance(api, instanceUuid)
  let status = Number(info?.status)
  if (waitForStartup && (status === 0 || STOPPED_STATUSES.has(status))) {
    // A successful or unknown startup receipt can precede the state transition.
    info = await waitForInstanceStatus(api, instanceUuid, new Set([...STARTING_STATUSES, RUNNING_STATUS]), { timeoutMs: 8_000, intervalMs: 2_000 })
      .catch(() => info)
    status = Number(info?.status)
  }
  if (STARTING_STATUSES.has(status)) {
    info = await waitForInstanceStatus(api, instanceUuid, new Set([RUNNING_STATUS, ...STOPPED_STATUSES]), { timeoutMs })
    status = Number(info?.status)
  }
  let request
  if (status !== 0 && !STOPPED_STATUSES.has(status)) {
    if (!STOPPING_STATUSES.has(status)) {
      try {
        request = await api.post('/instance/shutdown', { instance_uuid: instanceUuid })
      } catch (error) {
        if (!/已关机|关机中|not running|already stopped/i.test(String(error?.message || error))) throw error
      }
    }
    info = await waitForInstanceStatus(api, instanceUuid, STOPPED_STATUSES, { timeoutMs, intervalMs: 2_500 })
  }
  return { ok: true, request, status: info?.status, status_name: instanceStatusName(info?.status) }
}
