/** Built-in workflow families and the coordinates used by pre-adaptation queue records. */

export const DEFAULT_WORKFLOWS = Object.freeze({
  image: Object.freeze({
    type: 'image',
    label: 'MOSS 文生图',
    workflow_name: 'YZ金鱼-MOSS-文生图.json',
    prompt_node: '88',
    prompt_input: 'value',
    seed_node: '13',
    seed_input: 'seed',
    megapixels_node: '8',
    aspect_ratio_node: '8',
  }),
  video: Object.freeze({
    type: 'video',
    label: 'MiniMax H3 图生视频',
    workflow_name: 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.json',
    prompt_node: '263',
    prompt_input: 'text',
    seed_node: '397',
    seed_input: 'seed',
    megapixels_node: '252',
    aspect_ratio_node: '252',
    duration_node: '259',
    duration_input: 'value',
    image_nodes: Object.freeze(['49', '50', '51', '43', '19', '23', '199', '200', '201']),
    video_nodes: Object.freeze(['25', '26', '27']),
    audio_nodes: Object.freeze(['15', '14', '48']),
  }),
})

const VIDEO_FILE_RE = /\.(mp4|mov|webm|avi|mkv|m4v)$/i
const AUDIO_FILE_RE = /\.(mp3|wav|flac|m4a|ogg|aac)$/i
const VIDEO_WORD_RE = /(视频|动画|动态|运镜|镜头|视频生成|图生视频|文生视频|video|animate|motion|minimax|h3)/i

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

const ASPECT_RATIO_ALIASES = {
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait)',
  '3:2': '3:2 (Landscape)',
  '3:4': '3:4 (Portrait)',
  '4:3': '4:3 (Landscape)',
  '9:16': '9:16 (Vertical)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
}

export function normalizeAspectRatio(value) {
  const text = String(value || '').trim()
  return ASPECT_RATIO_ALIASES[text.toLowerCase()] || text
}

function sampleFiles(files) {
  if (!files || typeof files !== 'object') return []
  return Object.values(files).map((spec) => String(typeof spec === 'string' ? spec : spec?.path || '')).filter(Boolean)
}

export function defaultWorkflowForType(type, config = {}) {
  if (type === 'video') {
    return { ...DEFAULT_WORKFLOWS.video, workflow_name: String(config.defaultVideoWorkflow || DEFAULT_WORKFLOWS.video.workflow_name) }
  }
  return { ...DEFAULT_WORKFLOWS.image, workflow_name: String(config.defaultImageWorkflow || DEFAULT_WORKFLOWS.image.workflow_name) }
}

export function inferWorkflowType(args) {
  const input = asRecord(args)
  const explicit = String(input.workflow_type || '').trim().toLowerCase()
  if (explicit === 'image' || explicit === 'video') return explicit
  const alias = workflowAlias(input.workflow_name)
  if (alias) return alias
  if (/moss|文生图|图生图/i.test(input.workflow_name || '')) return 'image'
  if (/h3|minimax|视频|video/i.test(input.workflow_name || '')) return 'video'
  if (input.duration != null) return 'video'
  if (Array.isArray(input.reference_videos) && input.reference_videos.length > 0) return 'video'
  if (Array.isArray(input.reference_audios) && input.reference_audios.length > 0) return 'video'
  for (const file of sampleFiles(input.files)) {
    if (VIDEO_FILE_RE.test(file) || AUDIO_FILE_RE.test(file)) return 'video'
  }
  const prompt = String(input.prompt || '')
  if (VIDEO_WORD_RE.test(prompt)) return 'video'
  return 'image'
}

export function workflowAlias(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return ''
  if (['image', 'img', 'moss', '文生图', '图片', '图像'].includes(text)) return 'image'
  if (['video', 'vid', 'h3', 'minimax', '视频', '图生视频'].includes(text)) return 'video'
  return ''
}

export function mergeOverrides(base, extra) {
  const result = {}
  for (const [nodeId, values] of Object.entries(asRecord(base))) {
    result[nodeId] = { ...asRecord(values) }
  }
  for (const [nodeId, values] of Object.entries(asRecord(extra))) {
    result[nodeId] = { ...(result[nodeId] || {}), ...asRecord(values) }
  }
  return result
}

export function buildDefaultOverrides(workflow, args) {
  const input = asRecord(args)
  const overrides = mergeOverrides({}, input.overrides)
  if (input.seed !== undefined && input.seed !== null && workflow.seed_node) {
    const seed = Number(input.seed)
    if (Number.isFinite(seed)) overrides[workflow.seed_node] = { ...(overrides[workflow.seed_node] || {}), [workflow.seed_input || 'seed']: Math.trunc(seed) }
  }
  if (input.megapixels !== undefined && input.megapixels !== null && workflow.megapixels_node) {
    const megapixels = Number(input.megapixels)
    if (Number.isFinite(megapixels)) overrides[workflow.megapixels_node] = { ...(overrides[workflow.megapixels_node] || {}), megapixels }
  }
  if (input.aspect_ratio && workflow.aspect_ratio_node) {
    overrides[workflow.aspect_ratio_node] = { ...(overrides[workflow.aspect_ratio_node] || {}), aspect_ratio: normalizeAspectRatio(input.aspect_ratio) }
  }
  if (input.duration !== undefined && input.duration !== null && workflow.duration_node) {
    const duration = Number(input.duration)
    if (Number.isFinite(duration)) overrides[workflow.duration_node] = { ...(overrides[workflow.duration_node] || {}), [workflow.duration_input || 'value']: Math.max(1, Math.min(15, duration)) }
  }
  return overrides
}

export function buildDefaultFiles(workflow, args) {
  const input = asRecord(args)
  const files = { ...asRecord(input.files) }
  const add = (nodeIds, values, inputName) => {
    if (!Array.isArray(values)) return
    let index = 0
    for (const value of values) {
      if (value === null || value === undefined || value === '') continue
      while (index < nodeIds.length && files[nodeIds[index]]) index += 1
      if (index >= nodeIds.length) break
      files[nodeIds[index]] = { path: String(value), input: inputName }
      index += 1
    }
  }
  add(workflow.image_nodes || [], input.reference_images, 'image')
  add(workflow.video_nodes || [], input.reference_videos, 'video')
  add(workflow.audio_nodes || [], input.reference_audios, 'audio')
  return files
}
