/** User-friendly error message mappings for common error patterns. */

/**
 * Transient network error patterns that suggest retrying
 */
export const TRANSIENT_ERROR_PATTERNS = [
  /fetch failed/i,
  /ECONN/i,
  /ETIMEDOUT/i,
  /ENOTFOUND/i,
  /socket/i,
  /network/i,
  /502 Bad Gateway/i,
  /503 Service Unavailable/i,
  /504 Gateway Timeout/i,
]

/**
 * Map error messages to user-friendly localized keys
 * @param {string} errorMessage - Raw error message
 * @param {object} locale - Locale translations object
 * @returns {string} Localized friendly message
 */
export function friendlyErrorMessage(errorMessage, locale) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return locale?.unknownError || '发生未知错误'
  }

  const msg = errorMessage.toLowerCase()

  // Network errors
  if (/fetch failed|network|连接/i.test(msg)) {
    return locale?.networkError || '网络连接失败,请检查网络设置'
  }
  if (/econn|enotfound|etimedout/i.test(msg)) {
    return locale?.connectionError || '无法连接到晨羽服务器,请稍后重试'
  }
  if (/502|503|504/.test(msg)) {
    return locale?.serviceUnavailable || '晨羽服务暂时不可用,请稍后重试'
  }

  // Authentication errors
  if (/unauthorized|401|invalid.*key|api.*key/i.test(msg)) {
    return locale?.authError || 'API Key 无效或已过期,请检查设置'
  }
  if (/forbidden|403/i.test(msg)) {
    return locale?.permissionError || '权限不足,请检查账户配额'
  }

  // Resource errors
  if (/not found|404/i.test(msg)) {
    return locale?.notFoundError || '请求的资源不存在'
  }
  if (/timeout|超时/i.test(msg) && !/comfy/i.test(msg)) {
    return locale?.timeoutError || '请求超时,请稍后重试'
  }

  // Quota errors
  if (/quota|limit|insufficient.*balance|余额不足/i.test(msg)) {
    return locale?.quotaError || '账户余额不足或已达配额限制'
  }

  // GPU errors
  if (/gpu.*unavailable|显卡.*不可用|no.*capacity/i.test(msg)) {
    return locale?.gpuUnavailable || '所选显卡暂无可用配额,请稍后重试或更换显卡'
  }

  // Instance errors
  if (/instance.*not.*found|实例.*不存在/i.test(msg)) {
    return locale?.instanceNotFound || '实例不存在或已被删除'
  }

  // ComfyUI errors (keep technical details for debugging)
  if (/comfy/i.test(msg)) {
    return `ComfyUI 错误: ${errorMessage.slice(0, 200)}`
  }

  // Validation errors (keep original message as it's usually clear)
  if (/invalid|必须|不能为空|格式错误/i.test(msg)) {
    return errorMessage
  }

  // Default: truncate long messages
  return errorMessage.length > 150 
    ? `${errorMessage.slice(0, 150)}...` 
    : errorMessage
}

/**
 * Check if an error is transient and worth retrying
 * @param {Error|string} error
 * @returns {boolean}
 */
export function isTransientError(error) {
  const message = String(error?.message || error)
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * Extract error message from various error types
 * @param {any} error
 * @returns {string}
 */
export function extractErrorMessage(error) {
  if (!error) return '未知错误'
  if (typeof error === 'string') return error
  if (error.message) return String(error.message)
  if (error.error) return String(error.error)
  return JSON.stringify(error).slice(0, 200)
}
