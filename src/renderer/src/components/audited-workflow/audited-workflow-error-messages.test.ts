import { describe, expect, it } from 'vitest'
import {
  getSelectTaskErrorMessage,
  getTaskListErrorMessage
} from './audited-workflow-error-messages'
import { SELECT_TASK_REASON_CODES } from '../../../../shared/audited-workflow-types'

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
