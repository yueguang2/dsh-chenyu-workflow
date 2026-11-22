/** Unit tests for constants module. */

import { describe, it, expect } from 'vitest'
import { CONSTANTS } from '../lib/constants.mjs'

describe('CONSTANTS', () => {
  it('should be frozen and immutable', () => {
    expect(Object.isFrozen(CONSTANTS)).toBe(true)
    expect(Object.isFrozen(CONSTANTS.EVENTS)).toBe(true)
    expect(Object.isFrozen(CONSTANTS.STATUS)).toBe(true)
  })

  it('should have all required event names', () => {
    expect(CONSTANTS.EVENTS.LIBRARY_CHANGED).toBe('chenyu-workflow:library-changed')
    expect(CONSTANTS.EVENTS.OPEN_WORKFLOWS).toBe('chenyu-workflow:open')
  })

  it('should have all status constants', () => {
    expect(CONSTANTS.STATUS.QUEUED).toBe('queued')
    expect(CONSTANTS.STATUS.RUNNING).toBe('running')
    expect(CONSTANTS.STATUS.SUCCEEDED).toBe('succeeded')
    expect(CONSTANTS.STATUS.FAILED).toBe('failed')
    expect(CONSTANTS.STATUS.CANCELLED).toBe('cancelled')
  })

  it('should have valid timeout values', () => {
    expect(CONSTANTS.TIMEOUT.DEFAULT_WORKFLOW).toBeGreaterThan(0)
    expect(CONSTANTS.TIMEOUT.MIN_WORKFLOW).toBeLessThan(CONSTANTS.TIMEOUT.MAX_WORKFLOW)
  })

  it('should have valid poll intervals', () => {
    expect(CONSTANTS.POLL_INTERVAL.ACTIVE).toBeGreaterThan(0)
    expect(CONSTANTS.POLL_INTERVAL.IDLE_MIN).toBeLessThan(CONSTANTS.POLL_INTERVAL.IDLE_MAX)
  })
})
