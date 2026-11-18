/** Read and manage cloud image versions through Chenyu's Pod API. */

import { instanceStatusName } from './comfy.mjs'
import { fetchInstance, RUNNING_STATUS, STOPPED_STATUSES } from './instance-ops.mjs'

export function cloudId(value, label) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-f0-9]{32}$/i.test(text)) throw new Error(`请输入有效的 ${label} UUID。`)
  return text.toLowerCase()
}

export function podVersionKey(podUuid, tag) {
  return `${podUuid}@${tag}`
}

export async function getPodDetail(api, podUuid, { signal } = {}) {
  const uuid = cloudId(podUuid, 'Pod')
  const origin = new URL(api.getConfig().baseUrl).origin
  const data = await api.post(`${origin}/api/pod/instances`, { pod_uuid: uuid }, { signal })
  const items = data?.result?.pod_instances ?? data?.data?.pod_instances ?? data?.pod_instances
  const pod = Array.isArray(items) && items.find((item) => String(item?.uuid ?? item?.pod_uuid ?? uuid).toLowerCase() === uuid)
  if (!pod) throw new Error(`没有查询到 Pod ${uuid}，请核对 ID 或镜像的访问权限。`)
  const versions = (Array.isArray(pod.pod_version_info) ? pod.pod_version_info : [])
    .map((item) => ({
      version_name: String(item?.version_name || '').trim(),
      version_updated_at: String(item?.version_updated_at || '').trim(),
      version_size: String(item?.version_size || '').trim(),
    }))
    .filter((item) => item.version_name)
    .sort((a, b) => b.version_updated_at.localeCompare(a.version_updated_at))
  return {
    uuid,
    title: String(pod.title || uuid),
    latest_tag: versions[0]?.version_name || '',
    latest_updated_at: versions[0]?.version_updated_at || '',
    versions,
  }
}

export async function listInstances(api, { signal } = {}) {
  const items = []
  const pageSize = 100
  for (let page = 1; page <= 10; page += 1) {
    const response = await api.get('/instance/list', { query: { page, page_size: pageSize }, signal })
    const list = Array.isArray(response?.instance_list) ? response.instance_list : []
    items.push(...list.filter((item) => item?.instance_uuid))
    if (list.length < pageSize || (Number(response?.total) > 0 && items.length >= Number(response.total))) break
  }
  return items
}

export async function listSavedPods(api, { state, instances, signal, onError } = {}) {
  const saved = await state.get()
  const seed = saved.savedPods == null && Array.isArray(instances)
  const existing = seed
    ? [...new Set(instances.map((item) => item.pod_uuid).filter((uuid) => /^[a-f0-9]{32}$/i.test(uuid)))].map((uuid) => ({ uuid }))
    : Object.values(saved.savedPods || {})
  const pods = (await Promise.all(existing.map(async (pod) => {
    try {
      return await getPodDetail(api, pod.uuid, { signal })
    } catch (error) {
      if (signal?.aborted) throw error
      onError?.(pod, error)
      return pod
    }
  }))).filter(Boolean)
  if (seed) {
    const initialized = await state.initializePods(pods)
    return Object.values(initialized.savedPods)
  }
  return pods
}

export function findPodInstance(instances, saved, podUuid, tag) {
  const candidates = instances.filter((item) => item.pod_uuid === podUuid && item.image_tag === tag)
  const preferred = saved?.podInstances?.[podVersionKey(podUuid, tag)]
  return candidates.find((item) => item.instance_uuid === preferred)
    || candidates.find((item) => item.instance_uuid === saved?.defaultInstanceUuid)
    || candidates.find((item) => Number(item.status) === 0 || STOPPED_STATUSES.has(Number(item.status)))
    || candidates.find((item) => Number(item.status) === RUNNING_STATUS)
    || candidates[0]
    || null
}

/** Called by the serial queue for an explicit Pod target, or by a confirmed version update. */
export async function ensurePodInstance(api, { state, podUuid, tag, gpuUuid, gpuNums = 1, signal, onCreating, ownsInstance } = {}) {
  const pod = await getPodDetail(api, podUuid, { signal })
  if (!pod.versions.some((version) => version.version_name === tag)) {
    throw new Error(`Pod「${pod.title}」没有版本 ${tag || '（未指定）'}，请刷新镜像列表。`)
  }
  const [instances, saved] = await Promise.all([listInstances(api, { signal }), state.get()])
  const eligible = ownsInstance ? instances.filter((item) => {
    if (Number(item.status) !== RUNNING_STATUS || ownsInstance(item.instance_uuid)) return true
    return (!gpuUuid || !item.gpu_uuid || item.gpu_uuid === gpuUuid)
      && (!item.gpu_nums || Number(item.gpu_nums) === gpuNums)
  }) : instances
  const existing = findPodInstance(eligible, saved, pod.uuid, tag)
  if (existing) return { instanceUuid: existing.instance_uuid, created: false }
  if (!gpuUuid) throw new Error('从 Pod 创建实例前请选择一张显卡。')
  signal?.throwIfAborted()
  onCreating?.(pod)
  const response = await api.post('/instance/create_by_pod', {
    pod_uuid: pod.uuid, pod_tag: tag, gpu_uuid: gpuUuid, gpu_nums: gpuNums,
  })
  const instanceUuid = String(response?.instance_uuid || response?.data?.instance_uuid || '')
  if (!instanceUuid) throw new Error('创建实例的回执缺少 UUID。请先核对晨羽实例列表，再重试。')
  return { instanceUuid, created: true }
}

export async function checkPodUpdate(api, { state, instanceUuid, signal } = {}) {
  const uuid = instanceUuid || await state.getDefaultInstanceUuid()
  if (!uuid) throw new Error('请选择要检测更新的 GPU 实例。')
  const info = await fetchInstance(api, uuid, signal)
  if (!info?.pod_uuid) throw new Error('此实例未关联 Pod，无法检测镜像版本。')
  const pod = await getPodDetail(api, info.pod_uuid, { signal })
  const currentTag = String(info.image_tag || '')
  const latestTag = pod.latest_tag
  const canReplace = Number(info.charging_type) !== 1 && [0, 22].includes(Number(info.status))
  return {
    ok: true,
    instance: {
      instance_uuid: uuid,
      status: info.status,
      status_name: instanceStatusName(info.status),
      charging_type: info.charging_type,
      image_tag: currentTag,
      pod_uuid: pod.uuid,
      gpu_uuid: info.gpu_uuid || '',
      gpu_name: info.gpu_name || '',
      gpu_nums: info.gpu_nums || 1,
    },
    pod,
    current_tag: currentTag,
    latest_tag: latestTag,
    update_available: Boolean(latestTag && latestTag !== currentTag),
    can_replace: canReplace,
    mode: 'create_instance',
  }
}

export async function applyPodUpdate(api, { state, instanceUuid, expectedTag, expectedCurrentTag, mode, gpuUuid, signal, onInstanceCreated } = {}) {
  const check = await checkPodUpdate(api, { state, instanceUuid, signal })
  if (!check.update_available) return { ok: true, updated: false, message: '实例已是最新版本。', check }
  if (expectedTag !== check.latest_tag || expectedCurrentTag !== check.current_tag) {
    throw new Error('检测后的实例版本或发布版本发生变化，请重新检测更新。')
  }
  if (mode === 'replace_image') {
    if (!check.can_replace) throw new Error('当前实例不支持原地更换镜像，请选择创建新版实例。')
    await api.post('/instance/replace_image', {
      instance_uuid: check.instance.instance_uuid, image_tag: check.latest_tag, pod_uuid: check.pod.uuid,
    })
    await onInstanceCreated?.(check.instance.instance_uuid)
    await state.invalidateCatalog(check.instance.instance_uuid)
    return { ok: true, updated: true, mode, check, message: `已提交 ${check.latest_tag} 镜像更换，开机状态以晨羽控制台为准。` }
  }
  if (mode !== 'create_instance') throw new Error('请确认镜像更新方式。')
  const target = await ensurePodInstance(api, {
    state, podUuid: check.pod.uuid, tag: check.latest_tag,
    gpuUuid: gpuUuid || check.instance.gpu_uuid, gpuNums: check.instance.gpu_nums, signal,
  })
  if (target.created) await onInstanceCreated?.(target.instanceUuid)
  await state.rememberPodInstance(check.pod.uuid, check.latest_tag, target.instanceUuid, { replaceDefault: check.instance.instance_uuid })
  const message = target.created ? '已创建新版镜像实例，原实例保留。' : '已添加现有新版实例，原实例保留。'
  return { ok: true, updated: true, mode, new_instance_uuid: target.instanceUuid, latest_tag: check.latest_tag, message, check }
}
