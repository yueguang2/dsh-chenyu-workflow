/** File helpers for workflow assets and generated outputs. */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
}

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
  'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/mp4': '.m4a',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'application/pdf': '.pdf',
}

const EXT_BY_TYPE = {
  image: '.png',
  video: '.mp4',
  audio: '.mp3',
  file: '.bin',
}

export function mediaTypeForPath(filePath) {
  const mime = MIME_BY_EXT[extname(filePath).toLowerCase()]
  if (!mime) return 'file'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'file'
}

export function mimeForPath(filePath) {
  return MIME_BY_EXT[extname(filePath).toLowerCase()] || 'application/octet-stream'
}

export async function uploadAsset(api, { filePath, mediaType, ttlHours, signal }) {
  const absolute = resolve(filePath)
  const info = await stat(absolute)
  if (!info.isFile()) throw new Error(`不是普通文件：${absolute}`)
  if (info.size > 100 * 1024 * 1024) throw new Error(`文件超过晨羽智云 100MB 上限：${absolute}`)
  const buffer = await readFile(absolute)
  const type = mediaType || mediaTypeForPath(absolute)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: mimeForPath(absolute) }), basename(absolute))
  form.append('media_type', type)
  form.append('purpose', 'temp_input')
  if (ttlHours) form.append('ttl_hours', String(ttlHours))
  return api.request('POST', '/assets', { form, signal, timeoutMs: 180_000 })
}

function normalizeOutputValue(value) {
  if (typeof value === 'string') return value ? [value] : []
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeOutputValue(item))
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'uri', 'href', 'content_url', 'signed_url']) {
      if (typeof value[key] === 'string' && value[key]) return [value[key]]
    }
  }
  return []
}

export function collectOutputUrls(outputs) {
  const rows = []
  if (!outputs || typeof outputs !== 'object') return rows
  for (const [outputKey, value] of Object.entries(outputs)) {
    for (const url of normalizeOutputValue(value)) {
      if (/^https?:\/\//i.test(url)) rows.push({ outputKey, url })
    }
  }
  return rows
}

function safeName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\0]/g, '_')
    .replace(/^\.+$/, '')
    .slice(0, 100)
  return cleaned || fallback
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function uniqueFilePath(dir, baseName, ext) {
  let candidate = join(dir, `${baseName}${ext}`)
  for (let index = 1; await exists(candidate); index += 1) {
    candidate = join(dir, `${baseName}-${index}${ext}`)
  }
  return candidate
}

export async function downloadOutputs({ outputs, outputManifest, outputDir, signal, timeoutMs = 180_000 }) {
  const urls = collectOutputUrls(outputs)
  if (urls.length === 0) {
    return { files: [], skipped: true, reason: '运行结果里没有可下载的 http(s) 媒体地址。' }
  }
  const typeByOutput = new Map()
  if (Array.isArray(outputManifest)) {
    for (const entry of outputManifest) {
      if (entry && typeof entry.name === 'string') typeByOutput.set(entry.name, entry.type || 'file')
    }
  }
  await mkdir(outputDir, { recursive: true })
  const files = []
  for (const { outputKey, url } of urls) {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal })
    if (!response.ok) {
      files.push({ outputKey, url, error: `HTTP ${response.status}` })
      continue
    }
    const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    let ext = EXT_BY_MIME[contentType] || extname(new URL(url).pathname).toLowerCase() || EXT_BY_TYPE[typeByOutput.get(outputKey)] || '.bin'
    if (!ext.startsWith('.')) ext = `.${ext}`
    const buffer = Buffer.from(await response.arrayBuffer())
    const filePath = await uniqueFilePath(outputDir, safeName(outputKey, 'output'), ext)
    await writeFile(filePath, buffer)
    files.push({
      outputKey,
      type: typeByOutput.get(outputKey) || (contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'file'),
      path: filePath,
      bytes: buffer.byteLength,
      contentType: contentType || undefined,
      url,
    })
  }
  return { files }
}
