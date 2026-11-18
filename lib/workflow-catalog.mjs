/** Read the workflows actually installed in an instance. Cache only by instance and image version. */

import { comfyServiceUrl, inspectWorkflowFile, instanceStatusName, listComfyWorkflows } from './comfy.mjs'
import { fetchInstance, RUNNING_STATUS, startAndWait } from './instance-ops.mjs'
import { findPodInstance, listInstances } from './pod-update.mjs'

export function cloudWorkflowName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > 512 || /[\\%\u0000-\u001f]/.test(name)
    || name.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('请输入镜像 workflows 目录中的文件名或相对路径。')
  }
  return name
}

function summarize(info) {
  return {
    instance_uuid: info.instance_uuid,
    pod_uuid: info.pod_uuid || '',
    image_tag: info.image_tag || '',
    status: info.status,
    status_name: instanceStatusName(info.status),
    gpu_uuid: info.gpu_uuid || '',
    gpu_name: info.gpu_name || '',
  }
}

export async function recordWorkflowCatalog(state, instance, files) {
  const workflows = Array.from(new Map(files.map((item) => {
    const name = typeof item === 'string' ? item : item?.name
    const workflow = { name }
    if (typeof item?.modified_at === 'number') workflow.modified_at = item.modified_at
    if (typeof item?.size === 'number') workflow.size = item.size
    return [name, workflow]
  })).values()).filter(({ name }) => /\.json$/i.test(name || '')).slice(0, 1000)
  const catalog = { ...summarize(instance), scanned_at: new Date().toISOString(), workflows }
  if (catalog.instance_uuid) await state.saveCatalog(catalog)
  return catalog
}

export async function readWorkflowCatalog(api, {
  state, instanceUuid, podUuid, podTag, workflowName, expectedImageTag, expectedPodUuid, signal,
} = {}) {
  let uuid = instanceUuid
  let versionCache
  if (podUuid) {
    const [instances, saved] = await Promise.all([listInstances(api, { signal }), state.get()])
    uuid = findPodInstance(instances, saved, podUuid, podTag)?.instance_uuid
    versionCache = Object.values(saved.workflowCatalogs || {})
      .filter((entry) => entry.pod_uuid === podUuid && entry.image_tag === podTag)
      .sort((a, b) => b.scanned_at.localeCompare(a.scanned_at))[0]
    if (!uuid) {
      return versionCache
        ? { ok: true, source: 'cache', ...versionCache, instance_uuid: '', status_name: '', message: '此镜像版本暂无实例，显示上次扫描的目录。运行时会按需创建实例。' }
        : { ok: true, source: 'unavailable', workflows: [], message: '此镜像版本尚无实例。可以填写准确文件名，或选择显卡后开机扫描目录。' }
    }
  }
  if (!uuid) throw new Error('请先选择云端实例或 Pod 镜像版本。')
  const info = await fetchInstance(api, uuid, signal)
  const instance = { ...info, instance_uuid: uuid }
  if (((podUuid || expectedPodUuid) && instance.pod_uuid !== (podUuid || expectedPodUuid))
    || ((podTag || expectedImageTag) && instance.image_tag !== (podTag || expectedImageTag))) {
    throw new Error('实例镜像版本已变化，请刷新来源后重新选择。')
  }
  const details = summarize(instance)
  const saved = (await state.get()).workflowCatalogs?.[uuid]
  const cached = saved && saved.pod_uuid === details.pod_uuid && saved.image_tag === details.image_tag ? saved : versionCache
  const url = Number(info.status) === RUNNING_STATUS && comfyServiceUrl(info)
  if (url) {
    try {
      const inspection = workflowName ? await inspectWorkflowFile(url, cloudWorkflowName(workflowName), { signal }) : undefined
      if (inspection) return { ok: true, source: 'live', workflows: cached?.workflows || [], ...details, inspection }
      const names = await listComfyWorkflows(url, { signal })
      const catalog = await recordWorkflowCatalog(state, instance, names)
      return { ok: true, source: 'live', ...catalog }
    } catch (error) {
      if (signal?.aborted) throw error
      if (workflowName || !cached) throw error
      return { ok: true, source: 'cache', ...cached, ...details, message: `实时读取失败，显示上次目录：${error.message}` }
    }
  }
  return cached
    ? { ok: true, source: 'cache', ...cached, ...details }
    : { ok: true, source: 'unavailable', workflows: [], ...details, message: '实例当前未运行。可选显卡后开机读取。' }
}

export async function scanWorkflowCatalog({ api, state, job, signal, onProgress, onInstanceUse }) {
  const { info, comfyUrl } = await startAndWait(api, job.instance_uuid, {
    signal, onInstanceUse, gpuUuid: job.gpu_uuid, gpuNums: job.gpu_nums, gpuName: job.gpu_name,
    expectedImageTag: job.pod_tag || job.expected_image_tag, expectedPodUuid: job.pod_uuid || job.expected_pod_uuid,
    onPhase: (phase, phase_label) => onProgress({ phase, phase_label, progress: phase === 'waiting_comfy' ? 15 : 4 }),
  })
  onProgress({ phase: 'scanning_workflows', phase_label: '读取镜像工作流', progress: 80 })
  const files = await listComfyWorkflows(comfyUrl, { signal })
  const catalog = await recordWorkflowCatalog(state, { ...info, instance_uuid: job.instance_uuid }, files)
  return { catalog, downloaded_files: [] }
}
