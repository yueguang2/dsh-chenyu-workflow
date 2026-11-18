/** Minimal Chenyu open API client used by the Host tools and settings routes. */

export class ChenyuApiError extends Error {
  constructor(message, { status = 0, code = 0, detail = '', payload = undefined } = {}) {
    super(message)
    this.name = 'ChenyuApiError'
    this.status = status
    this.code = code
    this.detail = detail
    this.payload = payload
  }
}

function errorText(payload, fallback) {
  if (!payload || typeof payload !== 'object') return fallback
  const nested = payload?.data?.error
  const parts = []
  if (typeof payload.msg === 'string' && payload.msg) parts.push(payload.msg)
  if (nested && typeof nested === 'object') {
    if (typeof nested.detail === 'string' && nested.detail) parts.push(nested.detail)
    if (typeof nested.engine_code === 'string' && nested.engine_code) parts.push(`engine_code=${nested.engine_code}`)
  }
  return parts.length > 0 ? parts.join(' | ') : fallback
}

export function createApi({ ctx, getConfig }) {
  async function resolveApiKey() {
    const cfg = getConfig()
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const hit = await credentials.resolve(cfg.apiKeyRef)
        if (hit && typeof hit.value === 'string' && hit.value.length > 0) return hit.value
      } catch {
        // Fall through to the process environment.
      }
    }
    return process.env[cfg.apiKeyRef] || ''
  }

  async function describeApiKey() {
    const cfg = getConfig()
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (credentials && typeof credentials.describe === 'function') {
      try {
        return await credentials.describe(cfg.apiKeyRef)
      } catch {
        // Fall through.
      }
    }
    return { configured: Boolean(process.env[cfg.apiKeyRef]), source: process.env[cfg.apiKeyRef] ? 'env' : undefined, writable: false }
  }

  async function setApiKey(value) {
    const cfg = getConfig()
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (!credentials || typeof credentials.set !== 'function') {
      throw new ChenyuApiError('当前 DSH 没有可用的凭据服务，无法保存 API Key；请改用环境变量 ' + cfg.apiKeyRef)
    }
    await credentials.set(cfg.apiKeyRef, value)
  }

  async function clearApiKey() {
    const cfg = getConfig()
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (!credentials || typeof credentials.unset !== 'function') {
      throw new ChenyuApiError('当前 DSH 没有可用的凭据服务，无法清除 API Key')
    }
    await credentials.unset(cfg.apiKeyRef)
  }

  function buildUrl(path, query) {
    const cfg = getConfig()
    // Most calls target the Open API base, but the console exposes a couple of
    // useful read-only endpoints (notably the public Pod detail) outside it.
    const target = /^https?:\/\//i.test(path) ? path : cfg.baseUrl.replace(/\/+$/, '') + path
    const url = new URL(target)
    if (query && typeof query === 'object') {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === '') continue
        url.searchParams.set(key, String(value))
      }
    }
    return url
  }

  async function request(method, path, { query, body, form, timeoutMs, signal } = {}) {
    const cfg = getConfig()
    const apiKey = await resolveApiKey()
    if (!apiKey) {
      throw new ChenyuApiError(
        `还没有配置晨羽智云 API Key。请在 DSH 设置 →「晨羽智云」里填写，或设置环境变量 ${cfg.apiKeyRef}。`,
        { status: 401, code: 2 },
      )
    }

    const url = buildUrl(path, query)
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    let payload
    if (form) {
      payload = form
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }

    const timeout = timeoutMs ?? cfg.requestTimeoutMs
    const timeoutSignal = AbortSignal.timeout(timeout)
    const compositeSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

    let response
    try {
      response = await fetch(url, { method, headers, body: payload, signal: compositeSignal })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' || error?.name === 'AbortError'
        ? `请求超时（${Math.round(timeout / 1000)} 秒）`
        : `网络请求失败：${String(error?.message ?? error)}`
      throw new ChenyuApiError(reason, { status: 0 })
    }

    const text = await response.text()
    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = undefined
    }

    if (!response.ok) {
      const message = errorText(json, `HTTP ${response.status} ${response.statusText}`.trim())
      throw new ChenyuApiError(message, {
        status: response.status,
        code: typeof json?.code === 'number' ? json.code : 0,
        detail: text.slice(0, 500),
        payload: json,
      })
    }

    if (json && typeof json === 'object' && typeof json.code === 'number' && json.code !== 0) {
      throw new ChenyuApiError(errorText(json, '晨羽智云接口返回失败'), {
        status: response.status,
        code: json.code,
        payload: json,
      })
    }

    return json && typeof json === 'object' && 'data' in json ? json.data : json
  }

  return {
    request,
    get: (path, options) => request('GET', path, options),
    post: (path, body, options) => request('POST', path, { ...options, body }),
    resolveApiKey,
    describeApiKey,
    setApiKey,
    clearApiKey,
    getConfig,
  }
}
