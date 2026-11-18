import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_STATE = {
  defaultInstanceUuid: '',
  defaultGpuImage: null,
  defaultGpuVideo: null,
  savedPods: null,
  podInstances: {},
  workflowCatalogs: {},
}

export function createStateStore(file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'chenyu-workflow', 'state.json')) {
  let cache
  let writeChain = Promise.resolve()

  async function read() {
    if (cache) return { ...cache }
    let parsed
    try {
      parsed = JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    cache = { ...DEFAULT_STATE, ...(parsed && typeof parsed === 'object' ? parsed : {}) }
    return { ...cache }
  }

  function update(fn) {
    const write = writeChain.then(async () => {
      const current = await read()
      const next = { ...current, ...fn(current) }
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.tmp-${process.pid}`
      await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
      await rename(temp, file)
      cache = next
      return { ...next }
    })
    writeChain = write.catch(() => {})
    return write
  }

  return {
    file,
    get: read,
    set: (patch) => update(() => patch),
    async getDefaultInstanceUuid() {
      return (await read()).defaultInstanceUuid || ''
    },
    setDefaultInstanceUuid(instanceUuid) {
      return update(() => ({ defaultInstanceUuid: String(instanceUuid || '') }))
    },
    async getDefaultGpus() {
      const state = await read()
      return { image: state.defaultGpuImage || null, video: state.defaultGpuVideo || null }
    },
    setDefaultGpu(workflowType, gpu) {
      const key = workflowType === 'video' ? 'defaultGpuVideo' : 'defaultGpuImage'
      return update(() => ({ [key]: gpu ? { gpu_uuid: gpu.gpu_uuid, gpu_name: gpu.gpu_name } : null }))
    },
    initializePods(pods) {
      return update((current) => current.savedPods == null
        ? { savedPods: Object.fromEntries(pods.map((pod) => [pod.uuid, pod])) }
        : {})
    },
    savePod(pod) {
      return update((current) => ({ savedPods: { ...current.savedPods, [pod.uuid]: pod } }))
    },
    removePod(podUuid) {
      return update((current) => {
        const pods = { ...current.savedPods }
        delete pods[podUuid]
        return { savedPods: pods }
      })
    },
    rememberPodInstance(podUuid, tag, instanceUuid, { replaceDefault } = {}) {
      return update((current) => ({
        podInstances: { ...current.podInstances, [`${podUuid}@${tag}`]: instanceUuid },
        defaultInstanceUuid: replaceDefault && current.defaultInstanceUuid === replaceDefault
          ? instanceUuid : current.defaultInstanceUuid,
      }))
    },
    saveCatalog(catalog) {
      return update((current) => {
        const entries = { ...current.workflowCatalogs, [catalog.instance_uuid]: catalog }
        return { workflowCatalogs: Object.fromEntries(Object.entries(entries)
          .sort(([, a], [, b]) => String(b.scanned_at).localeCompare(String(a.scanned_at)))
          .slice(0, 40)) }
      })
    },
    invalidateCatalog(instanceUuid) {
      return update((current) => {
        const catalogs = { ...current.workflowCatalogs }
        delete catalogs[instanceUuid]
        return { workflowCatalogs: catalogs }
      })
    },
  }
}
