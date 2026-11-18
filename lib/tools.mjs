/** Model-facing tools for Chenyu cloud GPU workflows. */

import { resolve } from 'node:path'
import { ChenyuApiError } from './api.mjs'
import { downloadOutputs, uploadAsset } from './media.mjs'

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'canceled'])

const output = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function errorResult(error) {
  if (error instanceof ChenyuApiError) {
    return {
      ok: false,
      error: error.message,
      status: error.status || undefined,
      code: error.code || undefined,
      detail: error.detail || undefined,
    }
  }
  return { ok: false, error: String(error?.message ?? error) }
}

/**
 * The Host only accepts lossless JSON tool values. JSON.stringify drops
 * explicit undefined properties (and normalizes NaN/Infinity), so every tool
 * return value passes through this boundary before registration.
 */
function toLosslessJson(value) {
  if (value === undefined) return null
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return { ok: false, error: '工具返回值不是无损 JSON，已阻止返回。' }
  }
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(new Error('操作已取消'))
      return
    }
    const timer = setTimeout(resolvePromise, ms)
    const onAbort = () => {
      clearTimeout(timer)
      rejectPromise(new Error('操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    setTimeout(() => signal?.removeEventListener('abort', onAbort), ms + 10)
  })
}

async function sessionDirectory(ctx, exec) {
  const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : ctx.workingDirectory
  if (directories && typeof directories.ensure === 'function' && exec?.agent) {
    try {
      return await directories.ensure(exec.agent, exec?.signal)
    } catch {
      // Fall back to the process working directory.
    }
  }
  return process.cwd()
}

function summarizeWorkflow(data) {
  if (!data || typeof data !== 'object') return data
  const parameters = Array.isArray(data.editable_parameter_manifest)
    ? data.editable_parameter_manifest.map((item) => ({
        name: item.name,
        display_name: item.display_name,
        description: item.description || '',
        value_type: item.value_type,
        required: item.required === true,
        default_value: item.default_value,
        choices: item?.ui_schema?.control === 'select'
          ? (item.ui_schema.options || []).map((option) => option.value)
          : undefined,
      }))
    : []
  const outputs = Array.isArray(data.candidate_output_manifest)
    ? data.candidate_output_manifest.map((item) => ({
        name: item.name,
        type: item.type,
        description: item.description || '',
      }))
    : []
  return {
    workflow_id: data.workflow_id,
    revision_id: data.revision_id,
    title: data.title,
    description: data.description || '',
    tags: data.tags,
    gpu_model: data.gpu_model,
    quote_currency: data.quote_currency,
    quote_amount: data.quote_amount,
    may_incur_external_model_cost: data.may_incur_external_model_cost === true,
    external_cost_notice: data.external_cost_notice || '',
    parameters,
    outputs,
  }
}

function validateInputs(detail, inputs) {
  const manifest = Array.isArray(detail?.editable_parameter_manifest) ? detail.editable_parameter_manifest : []
  const byName = new Map(manifest.map((item) => [item.name, item]))
  const unknown = Object.keys(inputs).filter((key) => !byName.has(key))
  const missing = manifest.filter((item) => item.required === true && inputs[item.name] === undefined).map((item) => item.name)
  const invalid = []
  for (const [name, value] of Object.entries(inputs)) {
    const item = byName.get(name)
    if (!item || value === undefined) continue
    const type = String(item.value_type || '')
    if (['int', 'integer'].includes(type) && !Number.isInteger(value)) {
      invalid.push({ name, expected: 'integer', received: value })
    } else if (['float', 'number'].includes(type) && typeof value !== 'number') {
      invalid.push({ name, expected: 'number', received: value })
    } else if (['bool', 'boolean'].includes(type) && typeof value !== 'boolean') {
      invalid.push({ name, expected: 'boolean', received: value })
    } else if (['string'].includes(type) && typeof value !== 'string') {
      invalid.push({ name, expected: 'string', received: value })
    } else if (['image_input', 'image', 'video_input', 'video', 'audio_input', 'audio', 'file_input', 'file'].includes(type) && typeof value !== 'string') {
      invalid.push({ name, expected: '资源字符串（asset:// 或 https://）', received: value })
    }
    if (item?.ui_schema?.control === 'select' && Array.isArray(item.ui_schema.options)) {
      const allowed = item.ui_schema.options.map((option) => option.value)
      if (!allowed.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) {
        invalid.push({ name, expected: `选项之一：${allowed.map((v) => JSON.stringify(v)).join(' / ')}`, received: value })
      }
    }
  }
  return { unknown, missing, invalid }
}

function compactExecution(execution) {
  if (!execution || typeof execution !== 'object') return undefined
  return {
    status: execution.status,
    progress_percent: execution.progress_percent,
    queue_info: execution.queue_info,
    progress_snapshot: execution.progress_snapshot,
    actual_execution_duration_sec: execution.actual_execution_duration_sec,
    compute_cost: execution.compute_cost,
    external_model_cost: execution.external_model_cost,
    total_cost: execution.total_cost,
    error: execution.error,
  }
}

function recentLogs(execution, limit = 8) {
  if (!execution || !Array.isArray(execution.logs)) return []
  return execution.logs.slice(-limit).map((log) => ({
    at: log.at,
    event_type: log.event_type,
    level: log.level,
    message: log.message,
    progress_percent: log.progress_percent,
  }))
}

async function fetchExecution(api, runOrderId, signal) {
  try {
    return await api.get('/workflow/run/execution', { query: { run_order_id: runOrderId }, signal })
  } catch {
    return undefined
  }
}

async function buildStatus(api, runOrderId, { includeLogs = false, signal } = {}) {
  const [info, execution] = await Promise.all([
    api.get('/workflow/run/info', { query: { run_order_id: runOrderId }, signal }),
    fetchExecution(api, runOrderId, signal),
  ])
  const status = execution?.status || info?.run_status
  return {
    ok: true,
    run_order_id: runOrderId,
    status,
    terminal: TERMINAL_STATUSES.has(status),
    run_status: info?.run_status,
    submission_status: info?.submission_status,
    settlement_status: info?.settlement_status,
    quote_amount: info?.quote_amount,
    final_amount: info?.final_amount,
    total_cost: info?.total_cost ?? execution?.total_cost,
    outputs: info?.outputs ?? execution?.outputs,
    error_code: info?.error_code || undefined,
    error_message: info?.error_message || undefined,
    execution: compactExecution(execution),
    logs: includeLogs ? recentLogs(execution) : undefined,
  }
}

export function registerTools(ctx, { api, config }) {
  const register = (definition) => {
    const wrapped = {
      ...definition,
      async execute(args, exec) {
        try {
          return toLosslessJson(await definition.execute(args, exec))
        } catch (error) {
          return toLosslessJson(errorResult(error))
        }
      },
    }
    return ctx.effect(
      () => ctx.tools.register(wrapped),
      `chenyu-workflow: tool ${definition.name}`,
    )
  }

  register({
    name: 'chenyu_workflow_list',
    description: '列出晨羽智云工作流市场中的已发布工作流（含当前 API Key 自己的非公开工作流）。先用它按关键词/标签找到要跑的文生图、图生图、文生视频工作流，再用 chenyu_workflow_info 读取提交参数。',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '按工作流标题关键字搜索，例如“文生图”“视频”' },
        tag: { type: 'string', description: '按单个标签精确筛选，例如“文生图”' },
        sort: { type: 'string', enum: ['latest', 'popular'], description: '排序，默认 latest' },
        page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
        page_size: { type: 'integer', description: '每页条数，默认 20，最大 100' },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const data = await api.get('/workflow/market/list', {
          query: {
            keyword: args?.keyword,
            tag: args?.tag,
            sort: args?.sort || 'latest',
            page: args?.page || 1,
            page_size: Math.min(100, Math.max(1, Number(args?.page_size) || 20)),
          },
          signal: exec?.signal,
        })
        return { ok: true, ...asRecord(data) }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_info',
    description: '查询一个晨羽智云工作流的详情：当前 revision_id、报价、GPU 型号，以及提交时必须遵守的参数清单（name、类型、是否必填、可选值）和输出清单。提交运行前必须先调用本工具，按返回的 parameters[].name 组装 inputs。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 ID，例如 wf_xxx' },
      },
      required: ['workflow_id'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const workflowId = String(args?.workflow_id || '').trim()
        if (!workflowId) return { ok: false, error: 'workflow_id 不能为空；请先调用 chenyu_workflow_list 查找。' }
        const data = await api.get('/workflow/market/info', { query: { workflow_id: workflowId }, signal: exec?.signal })
        return { ok: true, workflow: summarizeWorkflow(data) }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_upload',
    description: '把本地图片、视频、音频或文件上传到晨羽智云，得到可在工作流 inputs 中使用的 asset_uri（asset://asset_xxx）。当 chenyu_workflow_info 的某个参数 value_type 是 image_input/video_input/audio_input/file_input 且素材在本地时，先调用本工具。单文件最大 100MB。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '本地文件路径；相对路径按当前会话工作目录解析' },
        media_type: { type: 'string', enum: ['image', 'video', 'audio', 'file'], description: '资源类型；不填时按扩展名推断' },
        ttl_hours: { type: 'integer', description: '临时资源有效小时数，默认 48' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const relPath = String(args?.path || '').trim()
        if (!relPath) return { ok: false, error: 'path 不能为空。' }
        const cwd = await sessionDirectory(ctx, exec)
        const filePath = resolve(cwd, relPath)
        const data = await uploadAsset(api, {
          filePath,
          mediaType: args?.media_type,
          ttlHours: args?.ttl_hours,
          signal: exec?.signal,
        })
        return {
          ok: true,
          path: filePath,
          asset_id: data?.asset_id,
          asset_uri: data?.asset_uri,
          media_type: data?.media_type,
          mime_type: data?.mime_type,
          size_bytes: data?.size_bytes,
          expires_at: data?.expires_at,
          note: '把 asset_uri 完整字符串作为对应 inputs 参数值，不要只传 asset_id。',
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_run',
    description: '提交一次晨羽智云工作流运行（会按报价预扣费，完成后按实际消耗结算）。调用前先用 chenyu_workflow_info 读取参数清单；inputs 的 key 必须使用 parameters[].name，数字/布尔保留 JSON 类型，文件参数传 asset:// 或 https:// 资源字符串。默认会自动生成 idempotency_key。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '工作流 ID，例如 wf_xxx' },
        inputs: { type: 'object', additionalProperties: true, description: '按参数清单组装的工作流输入参数对象' },
        revision_id: { type: 'string', description: '可选：锁定工作流版本；不传则使用当前已发布版本' },
        idempotency_key: { type: 'string', description: '可选：幂等键；同一业务调用重试时保持不变，不传则自动生成' },
        accept_external_cost_risk: { type: 'boolean', description: '当详情提示 may_incur_external_model_cost 时必须显式传 true，表示接受第三方模型费用风险' },
      },
      required: ['workflow_id', 'inputs'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const workflowId = String(args?.workflow_id || '').trim()
        const inputs = asRecord(args?.inputs)
        if (!workflowId) return { ok: false, error: 'workflow_id 不能为空。' }
        const detail = await api.get('/workflow/market/info', { query: { workflow_id: workflowId }, signal: exec?.signal })
        const validation = validateInputs(detail, inputs)
        if (validation.unknown.length > 0 || validation.missing.length > 0 || validation.invalid.length > 0) {
          return {
            ok: false,
            error: 'inputs 与工作流参数清单不一致，未提交运行。',
            missing_required: validation.missing,
            unknown_parameters: validation.unknown,
            invalid_values: validation.invalid,
            workflow: summarizeWorkflow(detail),
          }
        }
        if (detail?.may_incur_external_model_cost === true && args?.accept_external_cost_risk !== true) {
          return {
            ok: false,
            needsConfirmation: true,
            error: '该工作流可能产生第三方模型费用。阅读 external_cost_notice 后，如接受风险请重新调用并传 accept_external_cost_risk=true。',
            external_cost_notice: detail.external_cost_notice || '',
            quote_amount: detail.quote_amount,
            quote_currency: detail.quote_currency,
          }
        }
        const idempotencyKey = String(args?.idempotency_key || '').trim()
          || `chenyu-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        const body = {
          workflow_id: workflowId,
          inputs,
          idempotency_key: idempotencyKey,
        }
        const revisionId = String(args?.revision_id || detail?.revision_id || '').trim()
        if (revisionId) body.revision_id = revisionId
        if (args?.accept_external_cost_risk === true) body.accept_external_cost_risk = true
        const data = await api.post('/workflow/run/submit', body, { signal: exec?.signal, timeoutMs: 180_000 })
        return {
          ok: true,
          ...asRecord(data),
          idempotency_key: idempotencyKey,
          workflow_title: detail?.title,
          hint: 'quote_amount 是预扣费参考报价，实际结算以运行完成后的实际消耗为准。用 run_order_id 调用 chenyu_workflow_wait 等待完成，或 chenyu_workflow_status 查看进度。',
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_status',
    description: '查询一次晨羽智云工作流运行的当前状态、进度、排队位置、费用和输出结果。用提交返回的 run_order_id 查询。',
    parameters: {
      type: 'object',
      properties: {
        run_order_id: { type: 'string', description: '运行订单 ID，例如 wfrun_xxx' },
        include_logs: { type: 'boolean', description: '是否包含最近 8 条执行日志，默认 false' },
      },
      required: ['run_order_id'],
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const id = String(args?.run_order_id || '').trim()
        if (!id) return { ok: false, error: 'run_order_id 不能为空。' }
        return await buildStatus(api, id, { includeLogs: args?.include_logs === true, signal: exec?.signal })
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_wait',
    description: '等待一次晨羽智云工作流运行进入终态（succeeded / failed / cancelled），期间按 2～5 秒轮询。适合视频生成等需要数分钟的任务；返回最终状态、费用和输出地址。若超时仍未终态，返回 timedOut=true，可再次调用继续等待。',
    parameters: {
      type: 'object',
      properties: {
        run_order_id: { type: 'string', description: '运行订单 ID，例如 wfrun_xxx' },
        timeout_seconds: { type: 'integer', description: '本次等待的最长秒数，默认 180，最大 900' },
        poll_interval_seconds: { type: 'integer', description: '轮询间隔秒数，默认 3，最小 2' },
      },
      required: ['run_order_id'],
      additionalProperties: false,
    },
    output,
    timeoutMs: 20 * 60 * 1000,
    async execute(args, exec) {
      const id = String(args?.run_order_id || '').trim()
      if (!id) return { ok: false, error: 'run_order_id 不能为空。' }
      const timeoutSeconds = Math.min(900, Math.max(5, Number(args?.timeout_seconds) || 180))
      const intervalMs = Math.min(60_000, Math.max(2_000, (Number(args?.poll_interval_seconds) || (config.pollIntervalMs / 1000)) * 1000))
      const deadline = Date.now() + timeoutSeconds * 1000
      let latest
      try {
        while (Date.now() <= deadline) {
          const execution = await fetchExecution(api, id, exec?.signal)
          let status = execution?.status
          if (!status) {
            const info = await api.get('/workflow/run/info', { query: { run_order_id: id }, signal: exec?.signal })
            status = info?.run_status
            latest = { info, execution }
          } else {
            latest = { execution }
          }
          if (TERMINAL_STATUSES.has(status)) {
            const statusResult = await buildStatus(api, id, { includeLogs: true, signal: exec?.signal })
            return { ...statusResult, ok: status === 'succeeded', terminal: true }
          }
          await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())), exec?.signal)
        }
        const final = latest?.execution
          ? await buildStatus(api, id, { includeLogs: true, signal: exec?.signal })
          : { ok: true, run_order_id: id, status: 'unknown', terminal: false }
        return {
          ...final,
          ok: false,
          timedOut: true,
          error: `等待超过 ${timeoutSeconds} 秒仍未进入终态；任务可能仍在运行，可再次调用 chenyu_workflow_wait 继续等待。`,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_download',
    description: '把一次已成功完成的晨羽智云工作流运行的输出图片/视频/音频下载到本地。默认保存到会话工作目录下的 generated/chenyu/<run_order_id>，返回每个文件的绝对路径。',
    parameters: {
      type: 'object',
      properties: {
        run_order_id: { type: 'string', description: '运行订单 ID，例如 wfrun_xxx' },
        output_dir: { type: 'string', description: '可选：下载目录；相对路径按会话工作目录解析，默认 generated/chenyu/<run_order_id>' },
      },
      required: ['run_order_id'],
      additionalProperties: false,
    },
    output,
    timeoutMs: 15 * 60 * 1000,
    async execute(args, exec) {
      try {
        const id = String(args?.run_order_id || '').trim()
        if (!id) return { ok: false, error: 'run_order_id 不能为空。' }
        const info = await api.get('/workflow/run/info', { query: { run_order_id: id }, signal: exec?.signal })
        if (!info?.outputs || typeof info.outputs !== 'object' || Object.keys(info.outputs).length === 0) {
          return {
            ok: false,
            error: `运行 ${id} 还没有可下载的输出（run_status=${info?.run_status || 'unknown'}）。请先用 chenyu_workflow_wait 确认成功。`,
            run_status: info?.run_status,
          }
        }
        let manifest
        try {
          const workflow = await api.get('/workflow/market/info', { query: { workflow_id: info.workflow_id }, signal: exec?.signal })
          manifest = workflow?.candidate_output_manifest
        } catch {
          manifest = undefined
        }
        const cwd = await sessionDirectory(ctx, exec)
        const dirArg = String(args?.output_dir || '').trim() || `${config.outputDir}/${id}`
        const outputDir = resolve(cwd, dirArg)
        const result = await downloadOutputs({
          outputs: info.outputs,
          outputManifest: manifest,
          outputDir,
          signal: exec?.signal,
          timeoutMs: 10 * 60 * 1000,
        })
        return {
          ok: true,
          run_order_id: id,
          dir: outputDir,
          files: result.files,
          skipped: result.skipped || false,
          outputs: info.outputs,
        }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_workflow_runs',
    description: '查询当前 API Key 提交过的晨羽智云工作流运行记录，可按工作流和状态筛选，用于找回之前的 run_order_id 或查看历史花费。',
    parameters: {
      type: 'object',
      properties: {
        workflow_id: { type: 'string', description: '可选：只看某个工作流' },
        status: { type: 'string', description: '可选：运行状态，如 queued、running、succeeded、failed' },
        page: { type: 'integer', description: '页码，从 1 开始，默认 1' },
        page_size: { type: 'integer', description: '每页条数，默认 20，最大 100' },
      },
      additionalProperties: false,
    },
    output,
    async execute(args, exec) {
      try {
        const data = await api.get('/workflow/run/list', {
          query: {
            workflow_id: args?.workflow_id,
            status: args?.status,
            page: args?.page || 1,
            page_size: Math.min(100, Math.max(1, Number(args?.page_size) || 20)),
          },
          signal: exec?.signal,
        })
        return { ok: true, ...asRecord(data) }
      } catch (error) {
        return errorResult(error)
      }
    },
  })

  register({
    name: 'chenyu_account',
    description: '查询晨羽智云账户余额（余额和算力卡余额），在提交付费工作流前可以先确认余额。',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    output,
    async execute(_args, exec) {
      try {
        const data = await api.get('/balance/info', { signal: exec?.signal })
        return { ok: true, ...asRecord(data) }
      } catch (error) {
        return errorResult(error)
      }
    },
  })
}
