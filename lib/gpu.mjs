/** GPU catalog helpers: list platform GPUs, match names/UUIDs, pick workflow defaults. */

const CACHE_MS = 60_000
const catalogs = new WeakMap()

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/nvidia|geforce|rtx/g, '')
    .replace(/[\s_\-()（）·]/g, '')
}

function inferMemoryGb(name) {
  const text = String(name || '')
  const explicit = text.match(/(\d+)\s*G(?:B)?/i)
  if (explicit) return Number(explicit[1])
  if (/4080/i.test(text)) return 16
  if (/4090/i.test(text)) return 24
  if (/3090/i.test(text)) return 24
  if (/5090/i.test(text)) return 32
  if (/A100/i.test(text)) return 80
  return null
}

export function publicGpu(item) {
  const input = asRecord(item)
  const status = Number(input.status)
  return {
    gpu_uuid: String(input.gpu_uuid || ''),
    gpu_name: String(input.gpu_name || ''),
    status,
    available: status === 1,
    price_hour: Number(input?.price?.hour) || 0,
    memory_gb: inferMemoryGb(input.gpu_name),
  }
}

export async function fetchGpuList(api, { signal, force = false } = {}) {
  const cached = catalogs.get(api)
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.gpus
  const data = await api.get('/gpu/list', { signal })
  const gpus = (Array.isArray(data?.gpu_list) ? data.gpu_list : [])
    .map(publicGpu)
    .filter((gpu) => gpu.gpu_uuid && gpu.gpu_name)
  catalogs.set(api, { at: Date.now(), gpus })
  return gpus
}

export function invalidateGpuList(api) {
  catalogs.delete(api)
}

export async function resolveGpu(api, value, { signal, requireAvailable = true, currentGpuUuid, force = false } = {}) {
  const text = typeof value === 'object' && value !== null
    ? String(value.gpu_uuid || value.gpu_name || '').trim()
    : String(value || '').trim()
  if (!text) return null
  const gpus = await fetchGpuList(api, { signal, force })
  let hit = gpus.find((gpu) => gpu.gpu_uuid === text)
    || gpus.find((gpu) => gpu.gpu_name.toLowerCase() === text.toLowerCase())
  if (!hit) {
    const normalized = normalizeText(text)
    const matches = gpus.filter((gpu) => {
      const candidate = normalizeText(gpu.gpu_name)
      return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate)
    })
    if (matches.length > 0) {
      hit = [...matches].sort((a, b) => a.gpu_name.length - b.gpu_name.length)[0]
    }
  }
  if (!hit) {
    const names = gpus.map((gpu) => `${gpu.gpu_name}${gpu.available ? '' : '（不可用）'}`).join('、')
    throw new Error(`没有找到匹配的显卡“${text}”。平台可用显卡：${names || '暂无'}`)
  }
  if (requireAvailable && !hit.available && hit.gpu_uuid !== currentGpuUuid) {
    if (!force) return resolveGpu(api, value, { signal, requireAvailable, currentGpuUuid, force: true })
    throw new Error(`显卡 ${hit.gpu_name} 当前没有可用配额，请选择其他显卡。`)
  }
  return hit
}

function savedGpu(stateValue) {
  const value = asRecord(stateValue)
  const uuid = String(value.gpu_uuid || '').trim()
  const name = String(value.gpu_name || '').trim()
  return uuid || name ? { gpu_uuid: uuid, gpu_name: name } : null
}

export async function resolveWorkflowGpu(api, { config, state, workflowType, gpu }, { signal, currentGpuUuid } = {}) {
  if (gpu) return resolveGpu(api, gpu, { signal, currentGpuUuid })
  const saved = state && typeof state.get === 'function' ? await state.get() : {}
  const key = workflowType === 'video' ? 'defaultGpuVideo' : 'defaultGpuImage'
  const fromState = savedGpu(saved?.[key])
  if (fromState) return resolveGpu(api, fromState, { signal, currentGpuUuid })
  const fallback = workflowType === 'video' ? config?.defaultVideoGpu : config?.defaultImageGpu
  if (!fallback) return null
  return resolveGpu(api, fallback, { signal, currentGpuUuid })
}

export function defaultGpuSummary(config, state = {}) {
  const fallback = (value) => {
    const text = String(value || '').trim()
    if (!text) return null
    return /^[0-9a-f]{24,}$/i.test(text) ? { gpu_uuid: text, gpu_name: '' } : { gpu_uuid: '', gpu_name: text }
  }
  return {
    image: savedGpu(state.defaultGpuImage) || fallback(config?.defaultImageGpu),
    video: savedGpu(state.defaultGpuVideo) || fallback(config?.defaultVideoGpu),
  }
}
