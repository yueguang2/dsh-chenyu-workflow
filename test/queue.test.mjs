import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { startAndWait } from '../lib/instance-ops.mjs'
import { createQueueManager } from '../lib/queue.mjs'
import { registerSettingsRoutes } from '../lib/settings-routes.mjs'
import { createStateStore } from '../lib/state.mjs'

const A = 'session-a'
const B = 'session-b'
const INSTANCE = '1'.repeat(32)
const POD = '2'.repeat(32)
const GPU = '3'.repeat(32)
const WAIT = 2000
const bounds = { timeout: 8000 }

async function fixture(t, { api = {}, runner, shutdown } = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), 'chenyu-queue-test-'))
  const config = { queueIdleGraceMs: 0 }
  const state = createStateStore(join(dir, 'state.json'))
  const queue = createQueueManager({ api, config, state, file: join(dir, 'queue.json'), runner, shutdown })
  t.after(async () => {
    try {
      await queue.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  return { dir, config, state, queue, api }
}

async function until(check, description) {
  const deadline = Date.now() + WAIT
  do {
    const result = await check()
    if (result) return result
    await delay(5)
  } while (Date.now() < deadline)
  assert.fail(`Timed out waiting for ${description}`)
}

async function finished(queue, job, status = 'succeeded') {
  const result = await queue.waitForJob(job.id, { sessionId: job.session_id, timeoutMs: WAIT })
  assert.ok(!result.timed_out, `Timed out waiting for ${job.id}`)
  assert.equal(result.status, status, result.error || `job ${job.id} ended in ${result.status}`)
  return result
}

test('the queue deduplicates per session, runs serially, and shuts down once after drain', bounds, async (t) => {
  const events = []
  const first = Promise.withResolvers()
  const { queue } = await fixture(t, {
    async runner({ job, onInstanceUse }) {
      await onInstanceUse(job.instance_uuid, { owned: job.session_id === A })
      events.push(`start ${job.session_id}`)
      if (job.session_id === A) await first.promise
      events.push(`end ${job.session_id}`)
      return {}
    },
    async shutdown(_api, uuid) {
      events.push(`shutdown ${uuid}`)
      return { ok: true }
    },
  })
  const input = { instance_uuid: INSTANCE, session_id: A, request_id: 'same-request' }
  try {
    const [a, duplicate, b] = await Promise.all([
      queue.enqueue(input), queue.enqueue(input), queue.enqueue({ ...input, session_id: B }),
    ])
    assert.equal(duplicate.id, a.id)
    assert.notEqual(b.id, a.id)
    await until(() => events.length, 'first runner')
    assert.deepEqual(events, [`start ${A}`])
    const snapshotA = await queue.getSnapshot({ sessionId: A })
    const snapshotB = await queue.getSnapshot({ sessionId: B })
    assert.deepEqual(snapshotA.active.map(({ id }) => id), [a.id])
    assert.deepEqual(snapshotA.queued, [])
    assert.deepEqual(snapshotB.active, [])
    assert.deepEqual(snapshotB.queued.map(({ id }) => id), [b.id])
    assert.equal(snapshotB.counts.active, 0)
    assert.equal(await queue.getJob(b.id, { sessionId: A }), null)
    await assert.rejects(queue.waitForJob(b.id, { sessionId: A, timeoutMs: WAIT }))

    first.resolve()
    const [, last] = await Promise.all([finished(queue, a), finished(queue, b)])
    assert.equal(last.shutdown?.instance_uuid, INSTANCE)
    assert.deepEqual(events, [`start ${A}`, `end ${A}`, `start ${B}`, `end ${B}`, `shutdown ${INSTANCE}`])
    for (const sessionId of [A, B]) {
      const snapshot = await queue.getSnapshot({ sessionId })
      assert.equal(snapshot.session_id, sessionId)
      assert.equal(snapshot.last_shutdown?.instance_uuid, INSTANCE)
      assert.equal(snapshot.history[0].shutdown?.instance_uuid, INSTANCE)
      assert.equal(snapshot.last_shutdown.jobIds, undefined)
      assert.equal(snapshot.last_shutdown.sessionIds, undefined)
    }
    assert.equal((await queue.getSnapshot({ sessionId: 'unrelated' })).last_shutdown, null)
    assert.equal((await queue.enqueue(input)).id, a.id)
    await queue.clearHistory({ sessionId: A })
    assert.deepEqual((await queue.getSnapshot({ sessionId: A })).history, [])
    assert.deepEqual((await queue.getSnapshot({ sessionId: B })).history.map(({ id }) => id), [b.id])
  } finally {
    first.resolve()
  }
})

test('cancelling on an already-running external instance avoids interrupt and shutdown', bounds, async (t) => {
  const comfyUrl = 'http://comfy.fixture.invalid'
  const promptId = 'owned-prompt'
  const requests = []
  const shutdowns = []
  t.mock.method(globalThis, 'fetch', async (url, { method, body }) => {
    requests.push([new URL(url).pathname, method, body && JSON.parse(body)])
    assert.equal(new URL(url).origin, comfyUrl)
    return Response.json({ queue_running: [[0, promptId], [1, 'external-prompt']] })
  })
  const { queue } = await fixture(t, {
    api: { async get(path) {
      assert.equal(path, '/instance/info')
      return { status: 2, gpu_uuid: GPU, server_url: [comfyUrl] }
    } },
    async runner({ api, job, signal, onInstanceUse, onProgress }) {
      const { comfyUrl: url } = await startAndWait(api, job.instance_uuid, { signal, onInstanceUse, waitComfy: false })
      signal.throwIfAborted()
      onProgress({ prompt_id: promptId, comfy_url: url })
      await once(signal, 'abort')
      signal.throwIfAborted()
    },
    async shutdown(_api, uuid) { shutdowns.push(uuid) },
  })
  const job = await queue.enqueue({ instance_uuid: INSTANCE, session_id: A })
  await until(async () => (await queue.getJob(job.id)).prompt_id === promptId, 'prompt receipt')
  await assert.rejects(queue.cancel(job.id, { sessionId: B }))
  assert.equal((await queue.getJob(job.id)).cancel_requested, false)
  await queue.cancel(job.id, { sessionId: A })
  await finished(queue, job, 'cancelled')
  await queue.stop()
  assert.deepEqual(requests, [['/queue', 'POST', { delete: [promptId] }], ['/queue', 'GET', undefined]])
  assert.deepEqual(shutdowns, [])
})

test('a Pod job creates and reuses the selected version, then rejects a removed version', bounds, async (t) => {
  const created = '4'.repeat(32)
  const listed = [{ instance_uuid: INSTANCE, pod_uuid: POD, image_tag: 'latest', status: 2 }]
  let versions = ['latest', 'selected']
  const creations = []
  const runs = []
  const api = {
    getConfig: () => ({ baseUrl: 'https://provider.fixture.invalid' }),
    async get(path) {
      assert.equal(path, '/instance/list')
      return { instance_list: [...listed] }
    },
    async post(path, body) {
      if (path === 'https://provider.fixture.invalid/api/pod/instances') {
        assert.deepEqual(body, { pod_uuid: POD })
        return { pod_instances: [{ uuid: POD, pod_version_info: versions.map((version_name) => ({ version_name })) }] }
      }
      assert.equal(path, '/instance/create_by_pod')
      creations.push(body)
      listed.push({ instance_uuid: created, pod_uuid: POD, image_tag: body.pod_tag, status: 2 })
      return { instance_uuid: created }
    },
  }
  const { queue, state } = await fixture(t, {
    api,
    async runner({ job }) { runs.push(job.instance_uuid); return {} },
    async shutdown() { return { ok: true } },
  })
  await state.setDefaultInstanceUuid(INSTANCE)
  const input = { pod_uuid: POD, pod_tag: 'selected', session_id: A, gpu_uuid: GPU, gpu_nums: 1 }
  await finished(queue, await queue.enqueue(input))
  await finished(queue, await queue.enqueue({ ...input, session_id: B }))
  versions = ['latest']
  const stale = await finished(queue, await queue.enqueue(input), 'failed')
  assert.match(stale.error, /selected/)
  assert.deepEqual(creations, [{ pod_uuid: POD, pod_tag: 'selected', gpu_uuid: GPU, gpu_nums: 1 }])
  assert.deepEqual(runs, [created, created])
  assert.equal((await state.get()).podInstances[`${POD}@selected`], created)
})

async function jobsRoute(t, fixture) {
  const routes = new Map()
  const peerSignal = new AbortController().signal
  const services = {
    webServer: { register: ({ path, handler }) => routes.set(path, handler) },
    connection: { admit: ({ headers }) => headers['x-fixture-role'] === 'anonymous'
      ? { rejection: 401 }
      : { peer: { principal: { kind: headers['x-fixture-role'] }, signal: peerSignal } } },
    sessionController: { resolveAgent: async (id) => ({ agent: [A, B].includes(id) ? { session: { id } } : null }) },
    workingDirectory: { ensure: async (agent) => join(fixture.dir, agent.session.id) },
  }
  registerSettingsRoutes({ get: (key) => services[key], effect: (register) => register() }, fixture)
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname)
    if (!handler) return res.writeHead(404).end()
    handler(req, res).catch((error) => res.writeHead(500).end(error.message))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((done) => {
    server.close(done)
    server.closeAllConnections()
  }))
  const url = `http://127.0.0.1:${server.address().port}/api/chenyu-workflow/jobs`
  return (params = {}, { body, role = 'owner' } = {}) => fetch(`${url}?${new URLSearchParams(params)}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-fixture-role': role, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(WAIT),
  })
}

async function json(response, status = 200) {
  const body = await response.json()
  assert.equal(response.status, status, JSON.stringify(body))
  return body
}

test('owner routes scope job reads, downloads, cancellation and retry by session', bounds, async (t) => {
  let providerReads = 0
  const deps = await fixture(t, {
    api: { async get(path) {
      assert.equal(path, '/instance/info')
      providerReads++
      return { image_tag: 'selected' }
    } },
    async runner({ job, signal }) {
      if (job.session_id === B) {
        signal.throwIfAborted()
        await once(signal, 'abort')
        signal.throwIfAborted()
      }
      const output_dir = join(job.base_dir, 'output')
      await mkdir(output_dir, { recursive: true })
      const path = join(output_dir, 'result.txt')
      const outside = join(job.base_dir, 'unrelated.txt')
      await Promise.all([writeFile(path, 'session A fixture'), writeFile(outside, 'outside output')])
      return { output_dir, downloaded_files: [{ path, filename: 'result.txt' }, { path: outside, filename: 'unrelated.txt' }] }
    },
  })
  const { dir, queue } = deps
  await Promise.all([mkdir(join(dir, A)), mkdir(join(dir, B))])
  const jobs = await jobsRoute(t, deps)
  const post = (body, role) => jobs({}, { body, role })
  const run = { action: 'run', session_id: A, request_id: 'run-request', instance_uuid: INSTANCE, workflow_name: 'fixture.json' }
  await json(await post(run, 'guest'), 403)
  await json(await jobs({ session_id: A }, { role: 'anonymous' }), 401)
  await json(await post({ ...run, session_id: 'closed-session' }), 404)
  assert.equal(providerReads, 0)
  const { job: a } = await json(await post(run))
  await finished(queue, a)
  const getA = { session_id: A, job_id: a.id }
  assert.equal((await json(await jobs(getA))).job.id, a.id)
  await json(await jobs({ ...getA, session_id: B }), 404)
  await json(await jobs({ ...getA, session_id: B, file: '0' }), 404)
  await json(await jobs({ ...getA, file: '0' }, { role: 'guest' }), 403)
  await json(await jobs({ ...getA, file: '1' }), 404)
  const file = await jobs({ ...getA, file: '0' })
  assert.equal(file.status, 200)
  assert.match(file.headers.get('content-disposition'), /attachment;.*result\.txt/)
  assert.equal(await file.text(), 'session A fixture')

  const { job: b } = await json(await post({ ...run, session_id: B }))
  const foreignCancel = await post({ action: 'cancel', session_id: A, job_id: b.id })
  const foreignRetry = await post({ action: 'retry', session_id: B, job_id: a.id, request_id: 'retry-request' })
  for (const response of [foreignCancel, foreignRetry]) {
    const body = await response.json()
    assert.ok([400, 404].includes(response.status), JSON.stringify(body))
    assert.equal(body.ok, false)
  }
  assert.equal((await queue.getJob(b.id, { sessionId: B })).cancel_requested, false)
  await json(await post({ action: 'cancel', session_id: B, job_id: b.id }))
  await finished(queue, b, 'cancelled')
  const retry = { action: 'retry', session_id: A, job_id: a.id, request_id: 'retry-request' }
  const { job: retried } = await json(await post(retry))
  assert.notEqual(retried.id, a.id)
  assert.equal((await json(await post(retry))).job.id, retried.id)
  await finished(queue, retried)
  const { history } = await json(await jobs({ session_id: B }))
  assert.deepEqual(history.map(({ id }) => id), [b.id])
})

test('an owner replay keeps its queue receipt after the instance version changes', bounds, async (t) => {
  let tag = 'selected'
  let providerReads = 0
  const deps = await fixture(t, {
    api: { async get(path) {
      assert.equal(path, '/instance/info')
      providerReads++
      return { image_tag: tag }
    } },
    async runner() { return {} },
  })
  await mkdir(join(deps.dir, A))
  const jobs = await jobsRoute(t, deps)
  const body = {
    action: 'run', session_id: A, request_id: 'run-request', instance_uuid: INSTANCE,
    expected_image_tag: tag, workflow_name: 'fixture.json',
  }
  const { job } = await json(await jobs({}, { body }))
  await finished(deps.queue, job)
  tag = 'next'
  const readsBeforeReplay = providerReads
  assert.equal((await json(await jobs({}, { body }))).job.id, job.id)
  assert.equal(providerReads, readsBeforeReplay)
  const stale = await json(await jobs({}, { body: { ...body, request_id: 'fresh-request' } }), 400)
  assert.match(stale.error, /版本/)
  const staleQueued = await deps.queue.enqueue({ instance_uuid: INSTANCE, expected_image_tag: 'selected', session_id: A })
  assert.match((await finished(deps.queue, staleQueued, 'failed')).error, /版本/)
})
