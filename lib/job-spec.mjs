/** Normalize model/user arguments into one durable queue job specification. */

import { basename, resolve } from 'node:path'
import { defaultWorkflowForType, inferWorkflowType, workflowAlias } from './defaults.mjs'

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function localPath(baseDir, value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 必须是非空的本地文件路径。`)
  return resolve(baseDir, value)
}

function references(baseDir, input, field, max) {
  if (input[field] == null) return []
  if (!Array.isArray(input[field]) || input[field].length > max) {
    throw new Error(`${field} 必须是最多包含 ${max} 条本地文件路径的数组。`)
  }
  return Array.from(input[field], (path, index) => localPath(baseDir, path, `${field}[${index}]`))
}

export function buildJobSpec(args, { config, defaultInstanceUuid = '', baseDir = process.cwd() } = {}) {
  const input = asRecord(args)
  const instanceUuid = String(input.instance_uuid || defaultInstanceUuid || '').trim()
  if (!instanceUuid && !(input.pod_uuid && input.pod_tag)) throw new Error('请选择实例或 Pod 镜像版本。')

  const workflowName = String(input.workflow_name || '').trim()
  const workflowFile = String(input.workflow_file || '').trim()
  const workflowJson = input.workflow_json ?? null
  if (workflowJson && (typeof workflowJson !== 'object' || Array.isArray(workflowJson))) {
    throw new Error('workflow_json 必须是 ComfyUI 工作流 JSON 对象。')
  }
  if ([workflowName, workflowFile, workflowJson].filter(Boolean).length > 1) {
    throw new Error('workflow_name、workflow_file、workflow_json 只能指定一个。')
  }
  const defaultType = workflowAlias(workflowName) || (!workflowName && !workflowFile && !workflowJson ? inferWorkflowType(input) : '')
  const workflow = defaultType ? defaultWorkflowForType(defaultType, config) : null
  const name = workflow?.workflow_name || workflowName
  const label = workflow?.label || (name || workflowFile ? basename(name || workflowFile).replace(/\.json$/i, '') : 'ComfyUI 工作流')
  const files = Object.fromEntries(Object.entries(asRecord(input.files)).map(([nodeId, spec]) => [
    nodeId,
    typeof spec === 'string'
      ? localPath(baseDir, spec, `files.${nodeId}`)
      : { ...asRecord(spec), path: localPath(baseDir, spec?.path, `files.${nodeId}.path`) },
  ]))

  return {
    instance_uuid: instanceUuid,
    session_id: input.session_id ? String(input.session_id) : '',
    gpu_uuid: input.gpu_uuid ? String(input.gpu_uuid) : '',
    gpu_name: input.gpu_name ? String(input.gpu_name) : '',
    gpu_nums: Number.isFinite(Number(input.gpu_nums)) ? Math.max(1, Math.trunc(Number(input.gpu_nums))) : 1,
    workflow_type: workflow?.type || inferWorkflowType(input),
    workflow_name: name || null,
    workflow_file: workflowFile ? localPath(baseDir, workflowFile, 'workflow_file') : null,
    workflow_json: workflowJson,
    workflow_label: label,
    workflow_default_type: defaultType,
    workflow_discovery: input.workflow_discovery !== false,
    workflow_adaptation: input.workflow_adaptation !== false,
    prompt: input.prompt == null ? '' : String(input.prompt),
    prompt_node: input.prompt_node == null ? '' : String(input.prompt_node),
    prompt_input: input.prompt_input == null ? '' : String(input.prompt_input),
    seed: input.seed,
    megapixels: input.megapixels,
    aspect_ratio: input.aspect_ratio,
    duration: input.duration,
    reference_images: references(baseDir, input, 'reference_images', 9),
    reference_videos: references(baseDir, input, 'reference_videos', 3),
    reference_audios: references(baseDir, input, 'reference_audios', 3),
    overrides: asRecord(input.overrides),
    files,
    output_dir: input.output_dir ? String(input.output_dir) : '',
    timeout_seconds: input.timeout_seconds,
    base_dir: resolve(baseDir),
  }
}

export function defaultWorkflowSummary(config = {}) {
  return Object.fromEntries(['image', 'video'].map((type) => {
    const { label, workflow_name } = defaultWorkflowForType(type, config)
    return [type, { label, workflow_name }]
  }))
}
