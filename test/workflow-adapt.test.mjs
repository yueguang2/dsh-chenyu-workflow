import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { buildJobSpec } from '../lib/job-spec.mjs'
import { ComfyError, convertWorkflowToPrompt } from '../lib/comfy.mjs'
import { runWorkflowJob } from '../lib/runner.mjs'
import { prepareWorkflow, resolveInstanceWorkflow } from '../lib/workflow-adapt.mjs'

const type = (name, options = {}) => [name, options]
const info = (required, optional = {}, rest = {}) => ({ input: { required, optional }, ...rest })
const node = (class_type, inputs, title = class_type) => ({ class_type, inputs, _meta: { title } })
const link = (id) => [String(id), 0]
const mossInfo = {
  ModelLoader: info({ unet_name: type(['MOSS/KOOK.safetensors']) }),
  PrimitiveStringMultiline: info({ value: type('STRING') }),
  ImageSize: info({ aspect_ratio: type('COMBO', { options: ['9:16 (Vertical)', '16:9 (Landscape)'] }), megapixels: type('FLOAT', { min: 0.25, max: 4 }) }),
  KSampler: info({ model: type('MODEL'), positive: type('STRING'), size: type('SIZE'), seed: type('INT', { min: 0, max: 99 }) }, { image: type('IMAGE') }),
  LoadImage: info({ image: type(['folder/real.png']) }),
  ImageResize: info({ image: type('IMAGE') }),
  SaveImage: info({ images: type('IMAGE') }, {}, { output_node: true }),
}
const moss = () => ({
  3: node('ModelLoader', { unet_name: 'MOSS/KOOK.safetensors' }),
  75: node('PrimitiveStringMultiline', { value: '' }),
  91: node('ImageSize', { aspect_ratio: '9:16 (Vertical)', megapixels: 1 }),
  96: node('LoadImage', { image: 'saved demo.png' }),
  97: node('ImageResize', { image: link(96) }),
  110: node('KSampler', { model: link(3), positive: link(75), size: link(91), seed: 1, image: link(97) }),
  130: node('SaveImage', { images: link(110) }),
  orphan: node('LoadImage', { image: 'missing unused image.png' }),
})

function uiFromApi(api, definitions) {
  const links = []
  const nodes = Object.entries(api).map(([id, definition]) => {
    const inputs = []
    const widgets_values_named = {}
    for (const [name, value] of Object.entries(definition.inputs)) {
      if (Array.isArray(value) && typeof value[0] === 'string') {
        const linkId = links.length + 1
        links.push([linkId, value[0], value[1], id, inputs.length, '*'])
        inputs.push({ name, link: linkId, type: '*' })
      } else {
        widgets_values_named[name] = value
      }
    }
    return { id, type: definition.class_type, title: definition._meta.title, mode: 0, inputs, widgets_values_named,
      outputs: (definitions[definition.class_type]?.output || ['*']).map((type) => ({ type })) }
  })
  return { nodes, links }
}

for (const format of ['api', 'ui']) {
  test(`MOSS ${format} drops disconnected example and missing optional LoadImage 96`, () => {
    const workflow = format === 'api' ? { prompt: moss() } : uiFromApi(moss(), mossInfo)
    const before = structuredClone(workflow)
    const result = prepareWorkflow(workflow, mossInfo, { prompt: 'forest', seed: 9, megapixels: 0.8, aspect_ratio: '16:9' })
    assert.equal(result.family, 'image')
    assert.equal(result.prompt['75'].inputs.value, 'forest')
    assert.equal(result.prompt['110'].inputs.seed, 9)
    assert.equal(result.prompt['91'].inputs.megapixels, 0.8)
    assert.equal(result.prompt['91'].inputs.aspect_ratio, '16:9 (Landscape)')
    assert.equal(result.prompt['110'].inputs.image, undefined)
    assert.equal(result.prompt['96'], undefined)
    assert.equal(result.prompt['97'], undefined)
    assert.equal(result.prompt.orphan, undefined)
    assert.match(result.warnings[0], /96/)
    assert.deepEqual(workflow, before)
  })
}

test('MOSS preserves an existing or supplied reference and rejects missing files serving a required branch', () => {
  const graph = moss()
  graph[96].inputs.image = 'real.png'
  assert.ok(prepareWorkflow(graph, mossInfo, {}).prompt[96])
  graph[96].inputs.image = 'saved demo.png'
  const supplied = prepareWorkflow(graph, mossInfo, { files: { 96: '/tmp/real.png' } })
  assert.ok(supplied.prompt[96])
  assert.deepEqual(supplied.files[96], { path: '/tmp/real.png', input: 'image' })
  const overrides = prepareWorkflow(graph, mossInfo, { overrides: { 96: { image: 'real.png' } } })
  assert.equal(overrides.prompt[96].inputs.image, 'folder/real.png')
  graph[200] = node('SaveImage', { images: link(97) })
  assert.throws(() => prepareWorkflow(graph, mossInfo, {}), /96.*所需的文件/)
  assert.throws(() => prepareWorkflow(graph, mossInfo, { files: { orphan: '/tmp/ref.png' } }), /显式指定的节点 orphan/)
})

const media = (names, kind, min = 0) => type('COMFY_AUTOGROW_V3', { template: { input: { required: { slot: type(kind) } }, names, min } })
const h3Info = {
  MinimaxHailuo03ReferenceNode: info({ model: type('COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'MiniMax H3', inputs: {
    required: { prompt: type('STRING'), duration: type('INT', { min: 1, max: 15 }), reference_images: media(['image_1', 'image_2'], 'IMAGE'), reference_audios: media(['audio_1'], 'AUDIO'), reference_videos: media(['video_1'], 'VIDEO') },
  } }] }), seed: type('INT') }),
  PrimitiveInt: info({ value: type('INT') }),
  LoadImage: info({ image: type(['sample.png']) }),
  LoadAudio: info({ audio: type(['sample.wav']) }),
  LoadVideo: info({ video: type(['sample.mp4']) }),
  SaveVideo: info({ video: type('VIDEO') }, {}, { output_node: true }),
}
const h3 = () => ({
  900: node('MinimaxHailuo03ReferenceNode', {
    model: 'MiniMax H3', 'model.prompt': '', 'model.duration': link(153), seed: 1,
    'model.reference_images.image_1': link(701), 'model.reference_images.image_2': link(101),
    'model.reference_audios.audio_1': link(644), 'model.reference_videos.video_1': link(754),
  }),
  153: node('PrimitiveInt', { value: 6 }),
  701: node('LoadImage', { image: 'sample.png' }),
  101: node('LoadImage', { image: 'sample.png' }),
  644: node('LoadAudio', { audio: 'example.wav' }),
  754: node('LoadVideo', { video: 'example.mp4' }),
  291: node('SaveVideo', { video: link(900) }),
})

test('H3 API maps remapped IDs by numbered socket, and omits unset reference families', () => {
  const result = prepareWorkflow(h3(), h3Info, {
    prompt: 'sunrise', seed: 12, duration: 8, reference_images: ['/tmp/first.png', '/tmp/second.png'], reference_audios: ['/tmp/ref.wav'],
  })
  assert.equal(result.family, 'video')
  assert.equal(result.prompt[900].inputs['model.prompt'], 'sunrise')
  assert.equal(result.prompt[153].inputs.value, 8)
  assert.equal(result.prompt[900].inputs.seed, 12)
  assert.equal(result.files[701].path, '/tmp/first.png')
  assert.equal(result.files[101].path, '/tmp/second.png')
  assert.equal(result.files[644].path, '/tmp/ref.wav')
  assert.equal(result.prompt[900].inputs['model.reference_videos.video_1'], undefined)
  assert.equal(result.prompt[754], undefined)
})

test('H3 UI can activate supplied bypassed reference loaders', () => {
  const workflow = uiFromApi(h3(), h3Info)
  for (const node of workflow.nodes) if (/^Load/.test(node.type)) node.mode = 4
  const result = prepareWorkflow(workflow, h3Info, {
    files: { 701: '/tmp/explicit.png' }, reference_images: ['/tmp/next.png'], reference_videos: ['/tmp/ref.mp4'],
  })
  assert.equal(result.files[701].path, '/tmp/explicit.png')
  assert.equal(result.files[101].path, '/tmp/next.png')
  assert.equal(result.files[754].path, '/tmp/ref.mp4')
  assert.equal(result.prompt[900].inputs['model.reference_audios.audio_1'], undefined)
  assert.equal(result.prompt[644], undefined)
})

test('required H3 reference, conflicting manual inputs, and arbitrary video input remain explicit', () => {
  const definitions = structuredClone(h3Info)
  definitions.MinimaxHailuo03ReferenceNode.input.required.model[1].options[0].inputs.required.reference_images[1].template.min = 1
  const original = h3()
  assert.ok(prepareWorkflow(original, definitions, {}).prompt[701])
  original[701].inputs.image = 'missing.png'
  assert.throws(() => prepareWorkflow(original, definitions, {}), /701.*所需的文件/)
  assert.throws(() => prepareWorkflow(original, definitions, { overrides: { 701: { image: 'sample.png' } }, files: { 701: '/tmp/ref.png' } }), /同时指定了上传文件/)
  const other = { 1: node('LoadVideo', { video: 'sample.mp4' }), 2: node('SaveVideo', { video: link(1) }) }
  const result = prepareWorkflow(other, h3Info, { workflow_type: 'video' })
  assert.equal(result.prompt[1].inputs.video, 'sample.mp4')
  assert.throws(() => prepareWorkflow(other, h3Info, { reference_videos: ['/tmp/ref.mp4'] }), /请用 files/)
})

test('Comfy UI uses current widget order, skips frontend seed controls, and reads named video widgets', () => {
  const definitions = {
    Test: info({ steps: type('INT'), seed: type('INT'), message: type('STRING') }, {}, { input_order: { required: ['seed', 'steps', 'message'] } }),
    VHS_LoadVideo: info({ video: type(['demo.mp4']), force_rate: type('INT') }),
  }
  const workflow = { nodes: [
    { id: 1, type: 'Test', widgets_values: [42, 'randomize', 19, 'hello'] },
    { id: 2, type: 'VHS_LoadVideo', widgets_values: { video: 'demo.mp4', force_rate: 5, upload: 'widget-only' } },
  ] }
  const { prompt } = convertWorkflowToPrompt(workflow, definitions)
  assert.deepEqual({ ...prompt[1].inputs }, { seed: 42, steps: 19, message: 'hello' })
  assert.deepEqual({ ...prompt[2].inputs }, { video: 'demo.mp4', force_rate: 5 })
})

test('parameter collisions are rejected and explicit prompt targets are checked against schema', () => {
  const original = moss()
  original[110].inputs.seed = 1
  assert.throws(() => prepareWorkflow(original, mossInfo, { seed: 500 }), /0–99/)
  assert.throws(() => prepareWorkflow(original, mossInfo, { seed: 3, overrides: { 110: { seed: 2 } } }), /同时设置了不同的值/)
  assert.throws(() => prepareWorkflow(original, mossInfo, { prompt: 'sun', prompt_node: '91', prompt_input: 'megapixels' }), /没有找到可绑定/)
  assert.throws(() => prepareWorkflow(original, mossInfo, { aspect_ratio: '3:2' }), /可选范围/)
  assert.throws(() => prepareWorkflow(original, mossInfo, { seed: 3, workflow_adaptation: false }), /需要可识别/)
})

const jobOptions = { defaultInstanceUuid: 'instance', baseDir: '/tmp/workspace' }
const instanceGraphs = (rows) => ({ objectInfo: { ...mossInfo, ...h3Info }, read: async (name) => {
  if (Object.hasOwn(rows, name)) return rows[name]
  throw new ComfyError(`missing ${name}`, { status: 404 })
}, list: async () => Object.keys(rows) })

test('default discovery follows a unique active-family graph in renamed inventory', async () => {
  const defaultJob = buildJobSpec({ workflow_type: 'image' }, jobOptions)
  const unrelated = { 1: node('LoadImage', { image: 'sample.png' }), 2: node('SaveImage', { images: link(1) }), stale: node('ModelLoader', { unet_name: 'MOSS/KOOK.safetensors' }) }
  const readers = instanceGraphs({ 'nested/renamed 1.0.1.json': moss(), 'MOSS unrelated.json': unrelated, 'renamed h3.json': h3() })
  assert.equal((await resolveInstanceWorkflow(defaultJob, readers)).name, 'nested/renamed 1.0.1.json')
  assert.equal((await resolveInstanceWorkflow(buildJobSpec({ workflow_name: 'h3' }, jobOptions), readers)).name, 'renamed h3.json')
  await assert.rejects(() => resolveInstanceWorkflow({ ...defaultJob, workflow_discovery: false }, readers), /missing/)
  await assert.rejects(() => resolveInstanceWorkflow(buildJobSpec({ workflow_name: 'explicit.json' }, jobOptions), readers), /missing explicit/)
  await assert.rejects(() => resolveInstanceWorkflow(defaultJob, instanceGraphs({ a: moss(), 'A.json': moss(), 'B.json': moss() })), /多个同系列/)
})

test('new jobs persist absolute paths and older jobs retain manual overrides and files', () => {
  const spec = buildJobSpec({ workflow_name: 'h3', duration: 5, seed: 520, reference_images: ['ref.png'], files: { 101: { path: 'other.png' } } }, jobOptions)
  assert.equal(spec.workflow_type, 'video')
  assert.equal(spec.workflow_default_type, 'video')
  assert.equal(spec.seed, 520)
  assert.equal(spec.duration, 5)
  assert.equal(spec.prompt_node, '')
  assert.deepEqual(spec.reference_images, [resolve('/tmp/workspace', 'ref.png')])
  assert.equal(spec.files[101].path, resolve('/tmp/workspace', 'other.png'))

  const legacy = { workflow_name: 'YZ金鱼-MOSS-文生图.json', workflow_label: 'MOSS 文生图', prompt_node: '88', prompt_input: 'value', prompt: 'rose', overrides: { 110: { seed: 25 } }, files: { 96: '/tmp/rose.png' } }
  const prepared = prepareWorkflow(moss(), mossInfo, legacy)
  assert.equal(prepared.prompt[75].inputs.value, 'rose')
  assert.equal(prepared.prompt[110].inputs.seed, 25)
  assert.equal(prepared.files[96].path, '/tmp/rose.png')
})

test('runner submits the prepared graph once and reports receipts even during cancellation', async (t) => {
  const comfyUrl = 'https://comfy.example.test'
  const abort = new AbortController()
  const requestPaths = []
  const progress = []
  const leases = []
  const catalogs = []
  const job = buildJobSpec({ workflow_type: 'image', prompt: 'rose', seed: 5 }, jobOptions)
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const { origin, pathname } = new URL(url)
    assert.equal(origin, comfyUrl)
    requestPaths.push(pathname)
    if (pathname === '/system_stats') return Response.json({ system: { comfyui_version: 'fixture' } })
    if (pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] })
    if (pathname === '/object_info') return Response.json(mossInfo)
    if (pathname === '/v2/userdata') return Response.json([
      { type: 'directory', path: 'workflows/1.0.1' },
      { type: 'file', path: 'workflows/1.0.1/renamed.json' },
    ])
    if (pathname.startsWith('/userdata/')) {
      return decodeURIComponent(pathname.slice('/userdata/'.length)) === 'workflows/1.0.1/renamed.json'
        ? Response.json(moss()) : new Response('', { status: 404 })
    }
    if (pathname === '/prompt') {
      assert.equal(init.method, 'POST')
      const { prompt } = JSON.parse(init.body)
      assert.equal(prompt[96], undefined)
      assert.equal(prompt[75].inputs.value, 'rose')
      assert.equal(prompt[110].inputs.seed, 5)
      abort.abort(new Error('cancelled during POST'))
      return Response.json({ prompt_id: 'accepted-once' })
    }
    throw new Error(`unexpected request: ${pathname}`)
  })
  const api = { get: async (path) => {
    assert.equal(path, '/instance/info')
    return { status: 2, server_map: [{ port_type: 'http', title: 'ComfyUI', url: comfyUrl }] }
  } }
  await assert.rejects(runWorkflowJob({ api, job, config: {}, signal: abort.signal,
    onProgress: (patch) => progress.push(patch),
    onInstanceUse: (uuid, options) => leases.push({ uuid, ...options }),
    onWorkflowCatalog: (_instance, names) => catalogs.push(names),
  }), /cancelled during POST/)
  assert.deepEqual(leases, [{ uuid: 'instance', owned: false }])
  assert.deepEqual(catalogs, [['1.0.1/renamed.json']])
  assert.equal(progress.find((patch) => patch.resolved_workflow_name)?.resolved_workflow_name, '1.0.1/renamed.json')
  assert.equal(progress.at(-1)?.prompt_id, 'accepted-once')
  assert.equal(progress.at(-1)?.comfy_url, comfyUrl)
  assert.deepEqual(requestPaths.filter((path) => path === '/prompt'), ['/prompt'])
})
