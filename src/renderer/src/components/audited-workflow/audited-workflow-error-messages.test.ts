import { describe, expect, it } from 'vitest'
import {
  getSelectTaskErrorMessage,
  getStartTriageErrorMessage,
  getTaskListErrorMessage,
  isRetryableTriageReasonCode
} from './audited-workflow-error-messages'
import {
  SELECT_TASK_REASON_CODES,
  TRIAGE_REASON_CODES
} from '../../../../shared/audited-workflow-types'

describe('getSelectTaskErrorMessage', () => {
  it('returns a non-empty, user-safe message for every closed reason code', () => {
    for (const code of SELECT_TASK_REASON_CODES) {
      const message = getSelectTaskErrorMessage(code)
      expect(message.length).toBeGreaterThan(0)
    }
  })

  it('never echoes a reason code, path, or raw technical term into the message text', () => {
    const forbiddenSubstrings = ['/', '\\', '.ts:', 'Error:', 'stderr', 'stack']
    for (const code of SELECT_TASK_REASON_CODES) {
      const message = getSelectTaskErrorMessage(code)
      for (const forbidden of forbiddenSubstrings) {
        expect(message).not.toContain(forbidden)
      }
    }
  })
})

describe('getTaskListErrorMessage', () => {
  it('returns a non-empty, user-safe message', () => {
    expect(getTaskListErrorMessage().length).toBeGreaterThan(0)
  })
})

describe('getStartTriageErrorMessage', () => {
  it('returns a non-empty, user-safe message for every closed triage reason code', () => {
    for (const code of TRIAGE_REASON_CODES) {
      const message = getStartTriageErrorMessage(code)
      expect(message.length).toBeGreaterThan(0)
    }
  })

  it('never echoes a reason code, path, or raw technical term into the message text', () => {
    const forbiddenSubstrings = ['/', '\\', '.ts:', 'Error:', 'stderr', 'stack']
    for (const code of TRIAGE_REASON_CODES) {
      const message = getStartTriageErrorMessage(code)
      for (const forbidden of forbiddenSubstrings) {
        expect(message).not.toContain(forbidden)
      }
    }
  })
})

describe('isRetryableTriageReasonCode', () => {
  it('marks illegal_transition and lock_contended as non-retryable', () => {
    expect(isRetryableTriageReasonCode('illegal_transition')).toBe(false)
    expect(isRetryableTriageReasonCode('lock_contended')).toBe(false)
  })

  it('marks provider/output failures as retryable', () => {
    expect(isRetryableTriageReasonCode('provider_unavailable')).toBe(true)
    expect(isRetryableTriageReasonCode('provider_timeout')).toBe(true)
    expect(isRetryableTriageReasonCode('provider_error')).toBe(true)
    expect(isRetryableTriageReasonCode('output_invalid')).toBe(true)
  })
})
