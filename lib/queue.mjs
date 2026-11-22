/** Durable serial queue for Chenyu GPU workflow jobs and directory scans. */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createComfyClient, sleep } from './comfy.mjs'
import { CONSTANTS } from './constants.mjs'
import { fetchInstance, shutdownAndWait } from './instance-ops.mjs'
import { runWorkflowJob } from './runner.mjs'
import { defaultWorkflowSummary } from './job-spec.mjs'
import { defaultGpuSummary } from './gpu.mjs'
import { ensurePodInstance } from './pod-update.mjs'
import { recordWorkflowCatalog, scanWorkflowCatalog } from './workflow-catalog.mjs'

const TERMINAL = new Set([CONSTANTS.STATUS.SUCCEEDED, CONSTANTS.STATUS.FAILED, CONSTANTS.STATUS.CANCELLED])
const SPEC_KEYS = [
  'kind', 'instance_uuid', 'pod_uuid', 'pod_tag', 'expected_image_tag', 'expected_pod_uuid', 'session_id', 'request_id', 'gpu_uuid', 'gpu_name', 'gpu_nums',
  'workspace_only',
  'workflow_type', 'workflow_name', 'workflow_file', 'workflow_json', 'workflow_label', 'workflow_default_type',
  'workflow_adaptation', 'workflow_discovery', 'prompt', 'prompt_node', 'prompt_input', 'seed', 'megapixels',
  'aspect_ratio', 'duration', 'reference_images', 'reference_videos', 'reference_audios', 'overrides', 'files',
  'output_dir', 'timeout_seconds', 'base_dir',
]

function nowIso() {
  return new Date().toISOString()
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback
}

function createQueueStore(file) {
  let writeChain = Promise.resolve()
  return {
    file,
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return {}
        throw error
      }
    },
    save(data) {
      const text = `${JSON.stringify(data, null, 2)}\n`
      const write = writeChain.then(async () => {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 })
        const temp = `${file}.tmp-${process.pid}`
        await writeFile(temp, text, { mode: 0o600 })
        await rename(temp, file)
      })
      writeChain = write.catch(() => {})
      return write
    },
  }
}

function publicJob(job, queuePosition = null) {
  const downloaded = Array.isArray(job.result?.downloaded_files) ? job.result.downloaded_files : []
  return {
    id: job.id,
    seq: job.seq,
    kind: job.kind || 'run',
    status: job.status,
    phase: job.phase,
    phase_label: job.phase_label || '',
    progress: job.progress || 0,
    progress_detail: job.progress_detail || '',
    workflow_name: job.resolved_workflow_name || job.workflow_name || null,
    workflow_type: job.workflow_type || null,
    workflow_file: job.workflow_file || null,
    workflow_label: job.workflow_label || job.workflow_name || '工作流',
    prompt_preview: job.prompt_preview || '',
    instance_uuid: job.instance_uuid || '',
    pod_uuid: job.pod_uuid || '',
    pod_tag: job.pod_tag || '',
    session_id: job.session_id || '',
    gpu_uuid: job.gpu_uuid || '',
    gpu_name: job.gpu_name || '',
    gpu_nums: job.gpu_nums || 1,
    queue_position: queuePosition,
    created_at: job.created_at,
    updated_at: job.updated_at,
    started_at: job.started_at || null,
    finished_at: job.finished_at || null,
    elapsed_seconds: job.status === 'running' && job.started_at
      ? Math.max(0, Math.round((Date.now() - Date.parse(job.started_at)) / 1000)) : (job.elapsed_seconds ?? null),
    error: job.error || null,
    warnings: job.warnings || [],
    output_dir: job.result?.output_dir || job.output_dir || null,
    downloaded_files: downloaded.map(({ path, filename, bytes, error }) => ({ path, filename, bytes, error })),
    prompt_id: job.result?.prompt_id || job.prompt_id || null,
    gpu_switched: job.result?.gpu_switched === true || job.gpu_switched === true,
    cancel_requested: job.cancel_requested === true,
  }
}

function storedSpec(input) {
  return Object.fromEntries(SPEC_KEYS.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]))
}

function matchesSession(job, sessionId) {
  return sessionId == null || (job.session_id || '') === sessionId
}

export function createQueueManager({
  api, config, state, runner = runWorkflowJob, scan = scanWorkflowCatalog, shutdown = shutdownAndWait,
  file = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'chenyu-workflow', 'queue.json'),
} = {}) {
  const store = createQueueStore(file)
  let data = { version: 2, next_seq: 1, jobs: [], leases: {}, shutdowns: {}, updated_at: null }
  let loading
  let pumpPromise
  let exclusiveOperation
  let stopped = false
  let pumpTimer
  let current
  let settling
  let recoverLeases = false
  const waiters = new Set()

  function save() {
    data.updated_at = nowIso()
    return store.save(data)
  }

  function ensureLoaded() {
    if (!loading) {
      loading = (async () => {
        const saved = await store.load()
        data = { ...data, ...saved, version: 2 }
        recoverLeases = Object.keys(data.leases).length > 0
        for (const lease of Object.values(data.leases)) {
          delete lease.shuttingDown
          delete lease.retryAt
        }
        for (const job of data.jobs) {
          if (job.status !== 'running') continue
          Object.assign(job, {
            status: 'failed', phase: 'failed', phase_label: '已中断',
            error: '插件重启时任务仍在运行。请核对输出后再重试。',
            finished_at: nowIso(), updated_at: nowIso(),
          })
        }
        // Marked running jobs are never re-submitted automatically after a restart.
        await save()
      })()
    }
    return loading
  }

  function notify(job) {
    if (!TERMINAL.has(job.status)) return
    for (const waiter of waiters) {
      if (waiter.jobId === job.id) waiter.finish(completedJob(job))
    }
  }

  function schedulePump(delay = 0) {
    if (stopped) return
    clearTimeout(pumpTimer)
    pumpTimer = setTimeout(() => {
      pumpTimer = undefined
      if (pumpPromise) return
      pumpPromise = pump().catch((error) => {
        console.error('[chenyu-workflow] GPU queue:', error?.message ?? error)
      }).finally(() => { pumpPromise = undefined })
    }, delay)
    pumpTimer.unref?.()
  }

  function queuedJobs() {
    return data.jobs.filter((job) => job.status === 'queued').sort((a, b) => a.seq - b.seq)
  }

  function activeJobs() {
    return data.jobs.filter((job) => job.status === 'running' || job.status === 'queued')
  }

  async function recordInstanceUse(job, instanceUuid, { owned }) {
    const lease = data.leases[instanceUuid]
    if (!owned && !lease) return false
    const sessionIds = [...new Set([...(lease?.sessionIds || []), job.session_id].filter(Boolean))]
    data.leases[instanceUuid] = {
      sessionIds,
      jobIds: [...new Set([...(lease?.jobIds || []), job.id].filter(Boolean))],
      podUuid: job.pod_uuid || job.expected_pod_uuid || lease?.podUuid,
      podTag: job.pod_tag || job.expected_image_tag || lease?.podTag,
      scanOnly: (!lease || lease.scanOnly) && job.kind === 'scan',
    }
    delete data.shutdowns[instanceUuid]
    await save()
    return true
  }

  function canRelease(lease) {
    return config.autoShutdown !== false || lease.scanOnly
  }

  async function releaseIdleInstances({ recovering = false, unloading = false } = {}) {
    for (const [instanceUuid, lease] of Object.entries(data.leases)) {
      if (!unloading && (stopped || exclusiveOperation)) return
      if (!canRelease(lease)) continue
      if (!recovering && !unloading) {
        const next = queuedJobs()[0]
        const sameTarget = next?.pod_uuid
          ? next.pod_uuid === lease.podUuid && next.pod_tag === lease.podTag
          : next?.instance_uuid === instanceUuid
        if (sameTarget || lease.retryAt > Date.now()) continue
      }
      lease.shuttingDown = true
      let receipt
      try {
        receipt = await shutdown(api, instanceUuid, { timeoutMs: 120_000, waitForStartup: true })
        if (!receipt?.ok) throw new Error(receipt?.error || '晨羽未确认关机。')
        delete data.leases[instanceUuid]
      } catch (error) {
        receipt = { ok: false, error: String(error?.message ?? error) }
        delete lease.shuttingDown
        lease.retryAt = Date.now() + 60_000
      }
      const entry = { ...receipt, instance_uuid: instanceUuid, at: nowIso(), sessionIds: lease.sessionIds, jobIds: lease.jobIds }
      data.shutdowns[instanceUuid] = entry
      for (const job of data.jobs) {
        if (lease.jobIds?.includes(job.id)) job.shutdown = shutdownReceipt(entry)
      }
      await save()
    }
  }

  function shutdownReceipt(receipt) {
    if (!receipt) return null
    const { sessionIds, jobIds, request, ...visible } = receipt
    return visible
  }

  function completedJob(job) {
    const receipt = data.shutdowns[job.instance_uuid]
    const belongsToJob = receipt?.jobIds?.includes(job.id)
      || (receipt && !receipt.jobIds && receipt.at >= job.finished_at && receipt.sessionIds?.includes(job.session_id))
    return { ...publicJob(job), shutdown: job.shutdown || (belongsToJob ? shutdownReceipt(receipt) : null) }
  }

  function cancelRemotePrompt(execution) {
    const { job, comfyUrl } = execution
    if (execution.cancelPromise || !comfyUrl || !job.prompt_id) return
    execution.cancelPromise = (async () => {
      try {
        const client = createComfyClient(comfyUrl, { defaultTimeoutMs: 8000 })
        await client.post('/queue', { delete: [job.prompt_id] })
        const queue = await client.get('/queue')
        if (!queue?.queue_running?.some((item) => item[1] === job.prompt_id)) return
        if (!data.leases[job.instance_uuid]) {
          // Some older ComfyUI versions interpret /interrupt as a global action.
          job.warnings = ['此实例在提交前已运行。请在 ComfyUI 中确认该任务已停止。']
          return
        }
        await client.post('/interrupt', { prompt_id: job.prompt_id })
      } catch (error) {
        job.warnings = [`取消回执不完整：${error.message}`]
      }
    })()
  }

  async function runOne(job) {
    Object.assign(job, {
      status: 'running', phase: 'starting_instance', phase_label: '正在准备 GPU 实例',
      progress: 1, progress_detail: '', started_at: nowIso(), updated_at: nowIso(), error: null,
    })
    const execution = { job, abort: new AbortController(), comfyUrl: '', cancelPromise: null }
    current = execution
    const signal = execution.abort.signal
    let lastSavedAt = 0
    function onProgress(patch) {
      const phaseChanged = patch.phase && patch.phase !== job.phase
      if (patch.comfy_url) execution.comfyUrl = String(patch.comfy_url)
      const { comfy_url, ...publicPatch } = patch
      Object.assign(job, publicPatch, { updated_at: nowIso() })
      if (job.cancel_requested) cancelRemotePrompt(execution)
      if (phaseChanged || Date.now() - lastSavedAt > 4000) {
        lastSavedAt = Date.now()
        void save().catch(() => {})
      }
    }
    const onInstanceUse = (uuid, options) => recordInstanceUse(job, uuid, options)

    try {
      await save()
      if (job.pod_uuid) {
        signal.throwIfAborted()
        // Finish the creation handshake even if cancelled so any new instance can be tracked.
        const target = await ensurePodInstance(api, {
          state, podUuid: job.pod_uuid, tag: job.pod_tag, gpuUuid: job.gpu_uuid, gpuNums: job.gpu_nums,
          ownsInstance: (uuid) => Object.hasOwn(data.leases, uuid),
          signal, onCreating: () => onProgress({ phase: 'creating_instance', phase_label: '从云端镜像创建实例', progress: 3 }),
        })
        job.instance_uuid = target.instanceUuid
        if (target.created) await onInstanceUse(target.instanceUuid, { owned: true })
        await state.rememberPodInstance(job.pod_uuid, job.pod_tag, target.instanceUuid)
      } else if (job.expected_image_tag || job.expected_pod_uuid) {
        const info = await fetchInstance(api, job.instance_uuid, signal)
        if ((job.expected_image_tag && info.image_tag !== job.expected_image_tag)
          || (job.expected_pod_uuid && info.pod_uuid !== job.expected_pod_uuid)) {
          throw new Error('实例镜像版本已变化，请刷新工作流目录后重新提交。')
        }
      }
      signal.throwIfAborted()
      const invoke = job.kind === 'scan' ? scan : runner
      const result = await invoke({
        api, state, config, job, signal, onProgress, onInstanceUse,
        onWorkflowCatalog: (info, files) => recordWorkflowCatalog(state, { ...info, instance_uuid: job.instance_uuid }, files),
      })
      job.result = result
      job.prompt_id = result?.prompt_id || job.prompt_id || null
      if (job.cancel_requested) throw new Error('任务已取消')
      Object.assign(job, {
        status: 'succeeded', phase: 'succeeded', phase_label: '已完成', progress: 100,
        progress_detail: job.kind === 'scan'
          ? `找到 ${result?.catalog?.workflows?.length ?? 0} 个工作流`
          : `下载 ${result?.downloaded_files?.length ?? 0} 个文件`,
        warnings: Array.isArray(result?.warnings) ? result.warnings : [],
      })
    } catch (error) {
      const cancelled = job.cancel_requested === true
      if (job.prompt_id && !job.result) cancelRemotePrompt(execution)
      Object.assign(job, {
        status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed',
        phase_label: cancelled ? '已取消' : '失败',
        error: cancelled ? null : String(error?.message ?? error),
      })
    } finally {
      // Do not let an in-flight cancellation touch the next job's prompt.
      await execution.cancelPromise
      current = undefined
      job.finished_at = nowIso()
      job.updated_at = job.finished_at
      job.elapsed_seconds = Math.round((Date.now() - Date.parse(job.started_at)) / 1000)
      await save()
    }
  }

  async function pump() {
    await ensureLoaded()
    if (recoverLeases && !stopped && !exclusiveOperation) {
      recoverLeases = false
      await releaseIdleInstances({ recovering: true })
    }
    while (!stopped && !exclusiveOperation) {
      const job = queuedJobs()[0]
      settling = job
      try {
        if (job) await runOne(job)
        const grace = clampInt(config.queueIdleGraceMs, 0, 0, 60_000)
        if (grace && job && !queuedJobs().length && Object.values(data.leases).some(canRelease)) await sleep(grace)
        await releaseIdleInstances()
      } finally {
        settling = undefined
        if (job) notify(job)
      }
      if (!queuedJobs().length) break
    }
    if (!stopped && !exclusiveOperation) {
      const retryAt = Math.min(...Object.values(data.leases).filter(canRelease).map((lease) => lease.retryAt || Infinity))
      if (Number.isFinite(retryAt)) schedulePump(Math.max(1, retryAt - Date.now()))
    }
  }

  function lookup(jobId, sessionId) {
    const job = data.jobs.find((item) => item.id === String(jobId) && matchesSession(item, sessionId))
    if (!job) throw new Error(`队列里没有任务 ${jobId}。`)
    return job
  }

  async function getRequest(requestId, { sessionId } = {}) {
    await ensureLoaded()
    const job = data.jobs.find((item) => matchesSession(item, sessionId) && item.request_id === requestId)
    return job ? publicJob(job, queuedJobs().indexOf(job) + 1 || null) : null
  }

  async function enqueue(input) {
    await ensureLoaded()
    if (input.request_id) {
      const existing = data.jobs.find((job) => job.session_id === input.session_id && job.request_id === input.request_id)
      if (existing) return publicJob(existing, queuedJobs().indexOf(existing) + 1 || null)
    }
    if (stopped) throw new Error('队列已停止。')
    if (exclusiveOperation) throw new Error('正在操作云端实例，请等操作结束后再提交。')
    if (!input.instance_uuid && !(input.pod_uuid && input.pod_tag)) throw new Error('请选择云端实例或指定 Pod 版本。')
    if (activeJobs().length >= 100) throw new Error('队列已有 100 个待完成任务。')
    const seq = data.next_seq++
    const preview = String(input.prompt || '').replace(/\s+/g, ' ').trim()
    const job = {
      ...storedSpec(input), id: `job_${Date.now().toString(36)}_${seq}`, seq,
      kind: input.kind || 'run', status: 'queued', phase: 'queued', phase_label: '排队中', progress: 0,
      progress_detail: '等待前面的任务', workflow_label: input.workflow_label || 'ComfyUI 工作流',
      prompt_preview: preview.length > 60 ? `${preview.slice(0, 60)}…` : preview,
      timeout_seconds: clampInt(input.timeout_seconds, 1800, 60, 7200),
      created_at: nowIso(), updated_at: nowIso(),
    }
    data.jobs.push(job)
    const maxJobs = clampInt(config.queueMaxJobs, 100, 10, 1000)
    while (data.jobs.length > maxJobs) {
      const index = data.jobs.findIndex((item) => TERMINAL.has(item.status))
      if (index < 0) break
      data.jobs.splice(index, 1)
    }
    await save()
    schedulePump()
    return publicJob(job, queuedJobs().indexOf(job) + 1 || null)
  }

  async function getSnapshot({ limit = 20, sessionId } = {}) {
    await ensureLoaded()
    const savedState = await state.get()
    const visible = data.jobs.filter((job) => matchesSession(job, sessionId))
    const active = visible.filter((job) => job.status === 'running').map((job) => publicJob(job))
    const queued = queuedJobs().flatMap((job, i) => matchesSession(job, sessionId) ? [publicJob(job, i + 1)] : [])
    const history = visible.filter((job) => TERMINAL.has(job.status))
      .sort((a, b) => Date.parse(b.finished_at || b.updated_at) - Date.parse(a.finished_at || a.updated_at))
      .slice(0, clampInt(limit, 20, 1, 100)).map(completedJob)
    const instanceReceipts = Object.values(data.shutdowns).filter((item) => sessionId == null || item.sessionIds?.includes(sessionId))
    const lastShutdown = [...instanceReceipts, ...visible.flatMap((job) => job.shutdown ? [job.shutdown] : [])]
      .sort((a, b) => b.at.localeCompare(a.at))[0]
    return {
      ok: true, session_id: sessionId, active, queued, history,
      counts: Object.fromEntries(['running', 'queued', 'succeeded', 'failed', 'cancelled'].map((status) => [
        status === 'running' ? 'active' : status, visible.filter((job) => job.status === status).length,
      ])),
      auto_shutdown: config.autoShutdown !== false,
      default_workflows: defaultWorkflowSummary(config),
      default_gpus: defaultGpuSummary(config, savedState),
      last_shutdown: shutdownReceipt(lastShutdown),
      shutting_down: Object.values(data.leases).some((lease) => lease.shuttingDown && (sessionId == null || lease.sessionIds?.includes(sessionId))),
      pumping: sessionId == null ? Boolean(pumpPromise) : Boolean(active.length),
      updated_at: data.updated_at,
    }
  }

  async function getJob(jobId, { sessionId, includeWorkspace = false } = {}) {
    await ensureLoaded()
    const job = data.jobs.find((item) => item.id === String(jobId) && matchesSession(item, sessionId))
    if (!job) return null
    const visible = TERMINAL.has(job.status) ? completedJob(job) : publicJob(job)
    return includeWorkspace && job.workspace_only ? { ...visible, workspace: job.base_dir } : visible
  }

  async function waitForJob(jobId, { timeoutMs = 1_800_000, signal, sessionId } = {}) {
    await ensureLoaded()
    const job = lookup(jobId, sessionId)
    if (TERMINAL.has(job.status) && settling !== job) return completedJob(job)
    return new Promise((resolve, reject) => {
      const finish = (value, error) => {
        waiters.delete(waiter)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value)
      }
      const waiter = { jobId: job.id, finish, job }
      const timer = setTimeout(() => finish({ ...publicJob(job), timed_out: true }), Math.max(1000, timeoutMs))
      const abort = () => finish(null, new Error('等待被中断，任务仍在后台队列中。'))
      waiters.add(waiter)
      if (signal?.aborted) abort()
      else signal?.addEventListener('abort', abort, { once: true })
    })
  }

  async function cancel(jobId, { sessionId } = {}) {
    await ensureLoaded()
    const job = lookup(jobId, sessionId)
    if (TERMINAL.has(job.status) || job.cancel_requested) return publicJob(job)
    job.cancel_requested = true
    job.updated_at = nowIso()
    if (job.status === 'queued') {
      Object.assign(job, { status: 'cancelled', phase: 'cancelled', phase_label: '已取消', progress_detail: '', finished_at: nowIso() })
      await save()
      notify(job)
      schedulePump()
      return publicJob(job)
    }
    if (current?.job === job) {
      job.progress_detail = '正在取消…'
      cancelRemotePrompt(current)
      current.abort.abort()
    }
    await save()
    return publicJob(job)
  }

  async function clearHistory({ sessionId } = {}) {
    await ensureLoaded()
    data.jobs = data.jobs.filter((job) => !TERMINAL.has(job.status) || !matchesSession(job, sessionId))
    await save()
    return { ok: true, remaining: data.jobs.filter((job) => matchesSession(job, sessionId)).length }
  }

  async function retry(jobId, { sessionId, requestId } = {}) {
    if (requestId) {
      const existing = await getRequest(requestId, { sessionId })
      if (existing) return existing
    } else {
      await ensureLoaded()
    }
    const source = lookup(jobId, sessionId)
    if (!TERMINAL.has(source.status)) throw new Error('只能重试已结束的任务。')
    return enqueue({ ...storedSpec(source), request_id: requestId })
  }

  async function withIdleQueue(fn, { allowQueued = false, requireNoLeases = false } = {}) {
    await ensureLoaded()
    if (stopped || exclusiveOperation || settling || current || (!allowQueued && queuedJobs().length)
      || Object.values(data.leases).some((lease) => lease.shuttingDown)) {
      throw new Error('GPU 队列或实例操作正在进行，请稍后再试。')
    }
    if (requireNoLeases && Object.keys(data.leases).length) throw new Error('请先等队列启动的实例完成关机。')
    exclusiveOperation = Promise.resolve().then(fn)
    try {
      return await exclusiveOperation
    } finally {
      exclusiveOperation = undefined
      schedulePump()
    }
  }

  async function forgetInstance(uuid) {
    if (!data.leases[uuid]) return
    delete data.leases[uuid]
    await save()
  }

  return {
    async start() {
      stopped = false
      await ensureLoaded()
      schedulePump()
    },
    async stop() {
      stopped = true
      clearTimeout(pumpTimer)
      current?.abort.abort()
      for (const waiter of waiters) waiter.finish(publicJob(waiter.job))
      await pumpPromise
      await exclusiveOperation?.catch(() => {})
      if (loading) {
        await loading
        await releaseIdleInstances({ unloading: true })
      }
    },
    enqueue, getRequest, getSnapshot, getJob, waitForJob, cancel, clearHistory, retry, withIdleQueue, forgetInstance,
    trackInstance: (uuid, sessionId) => recordInstanceUse({ kind: 'scan', session_id: sessionId }, uuid, { owned: true }),
    hasActiveJobs: () => activeJobs().length > 0,
    activeJobs,
    get file() { return store.file },
  }
}
