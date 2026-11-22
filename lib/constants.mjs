/** Shared constants for the Chenyu workflow plugin. */

export const CONSTANTS = {
  // UI special values
  MANUAL_WORKFLOW: '__chenyu_manual__',
  MISSING_GPU: '__missing_default_gpu__',
  
  // Events
  EVENTS: {
    LIBRARY_CHANGED: 'chenyu-workflow:library-changed',
    OPEN_WORKFLOWS: 'chenyu-workflow:open',
  },
  
  // Job statuses
  STATUS: {
    QUEUED: 'queued',
    RUNNING: 'running',
    SUCCEEDED: 'succeeded',
    FAILED: 'failed',
    CANCELLED: 'cancelled',
  },
  
  // Workflow types
  WORKFLOW_TYPE: {
    AUTO: 'auto',
    IMAGE: 'image',
    VIDEO: 'video',
  },
  
  // Default timeouts
  TIMEOUT: {
    DEFAULT_WORKFLOW: 1800,
    MIN_WORKFLOW: 60,
    MAX_WORKFLOW: 7200,
    DEFAULT_WAIT: 3600,
  },
  
  // Draft autosave
  DRAFT_KEY_PREFIX: 'chenyu-draft-',
  DRAFT_SAVE_DELAY_MS: 1000,
  
  // Polling intervals
  POLL_INTERVAL: {
    ACTIVE: 1500,
    IDLE_MIN: 3000,
    IDLE_MAX: 30000,
    IDLE_INCREMENT: 2000,
  },
}

Object.freeze(CONSTANTS)
Object.freeze(CONSTANTS.EVENTS)
Object.freeze(CONSTANTS.STATUS)
Object.freeze(CONSTANTS.WORKFLOW_TYPE)
Object.freeze(CONSTANTS.TIMEOUT)
Object.freeze(CONSTANTS.POLL_INTERVAL)
