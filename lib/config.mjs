/** Configuration defaults and normalization for the Chenyu workflow plugin. */

export const DEFAULT_CONFIG = Object.freeze({
  /** Chenyu open API base URL. */
  baseUrl: 'https://www.chenyu.cn/api/open/v2',
  /** Credential reference (environment-variable shaped) that stores the API Key. */
  apiKeyRef: 'CHENYU_API_KEY',
  /** Default download directory, relative to the session working directory. */
  outputDir: 'generated/chenyu',
  /** Per-request timeout for ordinary API calls. */
  requestTimeoutMs: 60_000,
  /** Default polling interval while waiting for a workflow run. */
  pollIntervalMs: 3_000,
  /** Upper bound for one chenyu_workflow_wait call. */
  maxWaitSeconds: 900,
  /** Whether the workflow queue shuts the GPU instance down after it becomes empty. */
  autoShutdown: true,
  /** Optional time to wait for another queued job before idle shutdown. */
  queueIdleGraceMs: 0,
  /** Maximum number of job records kept in the durable queue file. */
  queueMaxJobs: 100,
  /** Default image workflow (the user's MOSS text-to-image workflow). */
  defaultImageWorkflow: 'YZ金鱼-MOSS-文生图.json',
  /** Default video workflow (the user's MiniMax H3 image-to-video workflow). */
  defaultVideoWorkflow: 'YZ金鱼-MiniMax_H3_终极篇-文武双全v2.json',
  /** Default GPU for image jobs (RTX 4080; enough for MOSS). */
  defaultImageGpu: 'c873233d835647ea8d985f370792a85a',
  /** Default GPU for video jobs (nGPU-48GB; RTX 4080 16GB crashes on longer H3 videos). */
  defaultVideoGpu: 'd92a57488465f63af5eaab49b403952f',
})

function positiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const baseUrl = String(input.baseUrl || DEFAULT_CONFIG.baseUrl).replace(/\/+$/, '')
  const apiKeyRef = String(input.apiKeyRef || DEFAULT_CONFIG.apiKeyRef).trim()
  return {
    baseUrl,
    apiKeyRef: /^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyRef) ? apiKeyRef : DEFAULT_CONFIG.apiKeyRef,
    outputDir: String(input.outputDir || DEFAULT_CONFIG.outputDir).trim() || DEFAULT_CONFIG.outputDir,
    requestTimeoutMs: positiveInt(input.requestTimeoutMs, DEFAULT_CONFIG.requestTimeoutMs, 5_000, 600_000),
    pollIntervalMs: positiveInt(input.pollIntervalMs, DEFAULT_CONFIG.pollIntervalMs, 2_000, 60_000),
    maxWaitSeconds: positiveInt(input.maxWaitSeconds, DEFAULT_CONFIG.maxWaitSeconds, 5, 3_600),
    autoShutdown: input.autoShutdown !== false,
    queueIdleGraceMs: positiveInt(input.queueIdleGraceMs, DEFAULT_CONFIG.queueIdleGraceMs, 0, 60_000),
    queueMaxJobs: positiveInt(input.queueMaxJobs, DEFAULT_CONFIG.queueMaxJobs, 10, 1_000),
    defaultImageWorkflow: String(input.defaultImageWorkflow || DEFAULT_CONFIG.defaultImageWorkflow).trim() || DEFAULT_CONFIG.defaultImageWorkflow,
    defaultVideoWorkflow: String(input.defaultVideoWorkflow || DEFAULT_CONFIG.defaultVideoWorkflow).trim() || DEFAULT_CONFIG.defaultVideoWorkflow,
    defaultImageGpu: String(input.defaultImageGpu || DEFAULT_CONFIG.defaultImageGpu).trim() || DEFAULT_CONFIG.defaultImageGpu,
    defaultVideoGpu: String(input.defaultVideoGpu || DEFAULT_CONFIG.defaultVideoGpu).trim() || DEFAULT_CONFIG.defaultVideoGpu,
  }
}
