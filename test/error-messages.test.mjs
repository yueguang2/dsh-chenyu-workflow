/** Unit tests for error message utilities. */

import { describe, it, expect } from 'vitest'
import { friendlyErrorMessage, isTransientError, extractErrorMessage } from '../lib/error-messages.mjs'

describe('friendlyErrorMessage', () => {
  const locale = {
    networkError: '网络连接失败',
    authError: 'API Key 无效',
    unknownError: '未知错误',
  }

  it('should handle network errors', () => {
    expect(friendlyErrorMessage('fetch failed', locale)).toBe(locale.networkError)
    expect(friendlyErrorMessage('Network error occurred', locale)).toBe(locale.networkError)
  })

  it('should handle authentication errors', () => {
    expect(friendlyErrorMessage('401 Unauthorized', locale)).toBe(locale.authError)
    expect(friendlyErrorMessage('Invalid API key', locale)).toBe(locale.authError)
  })

  it('should truncate long messages', () => {
    const longMsg = 'x'.repeat(200)
    const result = friendlyErrorMessage(longMsg, locale)
    expect(result.length).toBeLessThan(160)
    expect(result).toContain('...')
  })

  it('should preserve validation errors', () => {
    const validationMsg = '「seed」必须是整数'
    expect(friendlyErrorMessage(validationMsg, locale)).toBe(validationMsg)
  })

  it('should handle null/undefined', () => {
    expect(friendlyErrorMessage(null, locale)).toBe(locale.unknownError)
    expect(friendlyErrorMessage(undefined, locale)).toBe(locale.unknownError)
  })
})

describe('isTransientError', () => {
  it('should identify network errors as transient', () => {
    expect(isTransientError('fetch failed')).toBe(true)
    expect(isTransientError('ECONNREFUSED')).toBe(true)
    expect(isTransientError('502 Bad Gateway')).toBe(true)
  })

  it('should identify permanent errors as non-transient', () => {
    expect(isTransientError('401 Unauthorized')).toBe(false)
    expect(isTransientError('Invalid input')).toBe(false)
    expect(isTransientError('Resource not found')).toBe(false)
  })
})

describe('extractErrorMessage', () => {
  it('should extract from Error objects', () => {
    const error = new Error('Test error')
    expect(extractErrorMessage(error)).toBe('Test error')
  })

  it('should handle string errors', () => {
    expect(extractErrorMessage('Simple error')).toBe('Simple error')
  })

  it('should handle objects with error property', () => {
    expect(extractErrorMessage({ error: 'Object error' })).toBe('Object error')
  })

  it('should handle null/undefined', () => {
    expect(extractErrorMessage(null)).toBe('未知错误')
    expect(extractErrorMessage(undefined)).toBe('未知错误')
  })
})
