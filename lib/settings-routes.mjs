/** Owner-only HTTP routes for the Chenyu Web settings and session workflow panel. */

import { createReadStream } from 'node:fs'
import { lstat, realpath, readFile } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { sanitizeInstance } from './comfy.mjs'
import { defaultGpuSummary, fetchGpuList, invalidateGpuList, resolveGpu } from './gpu.mjs'
import { applyPodUpdate, checkPodUpdate, cloudId, getPodDetail, listInstances, listSavedPods } from './pod-update.mjs'
import { cloudTarget, prepareSubmission } from './submit.mjs'
import { cloudWorkflowName, readWorkflowCatalog } from './workflow-catalog.mjs'
import { within, workspaceDirectory, workspaceFile } from './workspace.mjs'

const PREFIX = '/api/chenyu-workflow'
const MAX_BODY_BYTES = 256 * 1024
const has = (record, key) => Object.hasOwn(record, key)
const errorText = (error) => String(error?.message ?? error)

class RouteError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function requestBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new RouteError(415, '请使用 application/json。')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.resume()
      throw new RouteError(413, '提交的数据太大。')
    }
    chunks.push(chunk)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请求必须为 JSON 对象。')
  return value
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function sessionIdentity(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{1,160}$/i.test(value)) throw new Error('缺少有效的 session_id。')
  return value
}

function requestIdentity(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_-]{8,128}$/i.test(value)) throw new Error('缺少有效的 request_id。')
  return value
}

function workspacePath(root, value, label) {
  if (typeof value !== 'string' || !value.trim() || isAbsolute(value) || !within(root, resolve(root, value))) {
    throw new Error(`${label} 必须是会话工作目录中的相对路径。`)
  }
  return resolve(root, value)
}

async function checkWorkspaceInputs(input, directory) {
  async function regularFile(value, label) {
    return workspaceFile(directory, workspacePath(directory, value, label), label)
  }
  for (const key of ['reference_images', 'reference_videos', 'reference_audios']) {
    if (!has(input, key)) continue
    if (!Array.isArray(input[key]) || input[key].length > (key === 'reference_images' ? 9 : 3)) throw new Error(`${key} 的文件数量无效。`)
    input[key] = await Promise.all(input[key].map((path) => regularFile(path, key)))
  }
  if (input.files) {
    if (typeof input.files !== 'object' || Array.isArray(input.files) || Object.keys(input.files).length > 40) throw new Error('files 必须是按节点 ID 指定的对象。')
    const entries = await Promise.all(Object.entries(input.files).map(async ([key, file]) => {
      if (!/^\d+(?::\d+)*$/.test(key)) throw new Error('files 的键必须是节点 ID。')
      if (typeof file === 'string') return [key, await regularFile(file, `files.${key}`)]
      return [key, { path: await regularFile(file?.path, `files.${key}`), input: file?.input }]
    }))
    input.files = Object.fromEntries(entries)
  }
  if (input.output_dir) {
    input.output_dir = await workspaceDirectory(directory, workspacePath(directory, input.output_dir, '输出目录'))
  }
}

async function deliverFile(res, job, index) {
  const file = /^\d+$/.test(index) ? job.downloaded_files[Number(index)] : null
  if (!file?.path || file.error || !job.output_dir) throw new RouteError(404, '找不到该输出文件。')
  try {
    const root = await realpath(job.output_dir)
    const path = await realpath(file.path)
    const info = await lstat(file.path)
    if (!within(root, path) || !info.isFile() || (job.workspace && !within(job.workspace, path))) {
      throw new Error('Invalid output file')
    }
    const filename = encodeURIComponent(basename(file.filename || path)).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream', 'Content-Length': info.size,
      'Content-Disposition': `attachment; filename*=UTF-8''${filename}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    })
    await pipeline(createReadStream(path), res)
  } catch {
    if (res.headersSent) return
    throw new RouteError(404, '输出文件已移动或不可读。')
  }
}

export function registerSettingsRoutes(ctx, { api, config, state, queue }) {
  const webServer = ctx.get('webServer')
  const connection = ctx.get('connection')
  if (!webServer || !connection) return

  async function authState() {
    const described = await api.describeApiKey()
    return { configured: described?.configured === true, source: described?.source || '', writable: described?.writable !== false }
  }

  function route(path, get, post) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: PREFIX + path,
      handler: async (req, res) => {
        const admission = connection.admit({ headers: req.headers })
        if (admission.peer?.principal?.kind !== 'owner') {
          sendJson(res, admission.rejection || 403, { ok: false, error: '请在授信的 DSH 页面登录后操作。' })
          return
        }
        const signal = AbortSignal.any([admission.peer.signal, AbortSignal.timeout(60_000)])
        try {
          const params = new URL(req.url || '/', 'http://localhost').searchParams
          let payload
          if (req.method === 'GET' && get) payload = await get(params, signal, res)
          else if (req.method === 'POST' && post) payload = await post(await requestBody(req), signal)
          else throw new RouteError(405, '该接口不支持此请求方法。')
          if (!res.headersSent) sendJson(res, 200, payload)
        } catch (error) {
          if (!res.headersSent) sendJson(res, error instanceof RouteError ? error.status : 400, { ok: false, error: errorText(error) })
        }
      },
    }), `chenyu-workflow: ${path} route`)
  }

  route('/jobs', async (params, _signal, res) => {
    const sessionId = sessionIdentity(params.get('session_id'))
    const jobId = params.get('job_id')
    if (!jobId) return queue.getSnapshot({ sessionId, limit: Number(params.get('limit') || 20) })
    const job = await queue.getJob(jobId, { sessionId, includeWorkspace: params.has('file') })
    if (!job) throw new RouteError(404, '当前会话没有该任务。')
    if (params.has('file')) return deliverFile(res, job, params.get('file'))
    return { ok: true, job }
  }, async (body, signal) => {
    const sessionId = sessionIdentity(body.session_id)
    const { action } = body
    if (action === 'cancel') return { ok: true, job: await queue.cancel(body.job_id, { sessionId }) }
    if (action === 'retry') return { ok: true, job: await queue.retry(body.job_id, { sessionId, requestId: requestIdentity(body.request_id) }) }
    if (action !== 'run' && action !== 'scan') throw new Error('未知队列操作。')
    const requestId = requestIdentity(body.request_id)
    const existing = await queue.getRequest(requestId, { sessionId })
    if (existing) return { ok: true, job: existing }
    const { agent } = await ctx.get('sessionController').resolveAgent(sessionId)
    if (!agent) throw new RouteError(404, '当前会话已关闭或不可用。')
    const baseDir = await realpath(await ctx.get('workingDirectory').ensure(agent, signal))
    if (!body.instance_uuid && !body.pod_uuid) throw new Error('请选择云端实例或 Pod 镜像版本。')
    const input = {
      instance_uuid: body.instance_uuid, pod_uuid: body.pod_uuid, pod_tag: body.pod_tag,
      expected_image_tag: body.expected_image_tag, expected_pod_uuid: body.expected_pod_uuid,
      gpu: body.gpu, gpu_nums: body.gpu_nums, request_id: requestId, workspace_only: true,
    }
    if (action === 'run') {
      input.workflow_name = cloudWorkflowName(body.workflow_name)
      for (const key of ['workflow_type', 'prompt', 'prompt_node', 'prompt_input', 'seed', 'megapixels', 'aspect_ratio', 'duration', 'reference_images', 'reference_videos', 'reference_audios', 'overrides', 'files', 'output_dir']) {
        if (has(body, key)) input[key] = body[key]
      }
      await checkWorkspaceInputs(input, baseDir)
    }
    const spec = await prepareSubmission({ api, config, state, input, sessionId, baseDir, signal, kind: action })
    return { ok: true, job: await queue.enqueue(spec) }
  })

  route('/library', async (params, signal) => {
    if (params.has('pod_uuid')) return { ok: true, pod: await getPodDetail(api, params.get('pod_uuid'), { signal }) }
    const [auth, saved] = await Promise.all([authState(), state.get()])
    const warnings = []
    let instances = []
    let gpus = []
    let pods = Object.values(saved.savedPods || {})
    if (auth.configured) {
      const withWarning = async (promise, label, fallback) => {
        try { return await promise } catch (error) {
          if (signal.aborted) throw error
          warnings.push(`${label}：${errorText(error)}`)
          return fallback
        }
      }
      const listedInstances = withWarning(listInstances(api, { signal }), '实例列表', null)
      ;[instances, gpus, pods] = await Promise.all([
        listedInstances,
        withWarning(fetchGpuList(api, { force: params.get('refresh') === '1', signal }), '显卡列表', []),
        listedInstances.then((items) => listSavedPods(api, {
          state, instances: items, signal, onError: (pod, error) => warnings.push(`${pod.title || pod.uuid}：${errorText(error)}`),
        })),
      ])
      instances ||= []
    }
    return {
      ok: true, ...auth, defaultInstanceUuid: saved.defaultInstanceUuid || '', defaultGpus: defaultGpuSummary(config, saved),
      autoShutdown: config.autoShutdown !== false,
      instances: instances.map((item) => sanitizeInstance(item, { includeServices: false })),
      pods, gpus, warnings,
    }
  }, async (body, signal) => {
    const uuid = cloudId(body.pod_uuid, 'Pod')
    if (body.action === 'remove_pod') {
      await state.removePod(uuid)
      return { ok: true }
    }
    if (body.action === 'save_pod') {
      const pod = await getPodDetail(api, uuid, { signal })
      await state.savePod(pod)
      return { ok: true, pod }
    }
    throw new Error('未知镜像库操作。')
  })

  route('/workflows', (params, signal) => {
    const source = cloudTarget(Object.fromEntries(params))
    return readWorkflowCatalog(api, {
      state, ...source, signal, workflowName: params.get('workflow_name'),
      expectedImageTag: params.get('expected_image_tag'), expectedPodUuid: params.get('expected_pod_uuid'),
    })
  })

  route('/settings', async () => {
    const [auth, saved] = await Promise.all([authState(), state.get()])
    return { ok: true, ...auth, apiKeyRef: config.apiKeyRef, defaultInstanceUuid: saved.defaultInstanceUuid, defaultGpus: defaultGpuSummary(config, saved) }
  }, async (body, signal) => {
    if (body.clear === true || has(body, 'apiKey')) {
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (body.clear !== true && (key.length < 8 || key.length > 4096)) throw new Error('请输入完整的晨羽智云 API Key。')
      await queue.withIdleQueue(async () => {
        if (body.clear === true) await api.clearApiKey()
        else await api.setApiKey(key)
        invalidateGpuList(api)
        await state.set({ workflowCatalogs: {}, podInstances: {} })
      }, { requireNoLeases: true })
    } else {
      const patch = {}
      for (const field of ['defaultGpuImage', 'defaultGpuVideo']) {
        if (has(body, field)) patch[field] = body[field] ? await resolveGpu(api, body[field], { signal, requireAvailable: false }) : null
      }
      if (has(body, 'defaultInstanceUuid')) {
        const uuid = body.defaultInstanceUuid ? cloudId(body.defaultInstanceUuid, '实例') : ''
        if (uuid && !(await listInstances(api, { signal })).some((instance) => instance.instance_uuid === uuid)) throw new Error('找不到该实例。')
        patch.defaultInstanceUuid = uuid
      }
      await state.set(patch)
    }
    const saved = await state.get()
    return { ok: true, ...await authState(), defaultInstanceUuid: saved.defaultInstanceUuid, defaultGpus: defaultGpuSummary(config, saved) }
  })

  route('/test', async (_params, signal) => {
    const balance = await api.get('/balance/info', { signal })
    return { ok: true, balance }
  })
  route('/gpus', async (_params, signal) => ({ ok: true, gpus: await fetchGpuList(api, { signal }), defaults: defaultGpuSummary(config, await state.get()) }))
  route('/instances', async (_params, signal) => ({ ok: true, instances: (await listInstances(api, { signal })).map((item) => sanitizeInstance(item, { includeServices: false })) }))

  route('/pod-update', (params, signal) => checkPodUpdate(api, {
    state, instanceUuid: params.has('instance_uuid') ? cloudId(params.get('instance_uuid'), '实例') : undefined, signal,
  }), (body, signal) => {
    if (body.action !== 'apply') throw new Error('请确认更新操作。')
    return queue.withIdleQueue(() => applyPodUpdate(api, {
      state, signal,
      instanceUuid: cloudId(body.instance_uuid, '实例'),
      expectedTag: body.expected_tag, expectedCurrentTag: body.expected_current_tag,
      mode: body.mode, gpuUuid: body.gpu ? cloudId(body.gpu, 'GPU') : undefined,
      onInstanceCreated: (uuid) => queue.trackInstance(uuid),
    }))
  })

  route('/locales', async () => {
    const locale = async (name) => JSON.parse(await readFile(new URL(`../locale/${name}.json`, import.meta.url), 'utf8')).ui || {}
    const [en, zh] = await Promise.all([locale('en'), locale('zh')])
    return { ok: true, en, zh }
  })
}
