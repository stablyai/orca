import { describe, expect, it } from 'vitest'
import {
  createTerminalSessionStateSaveFailureMessage,
  isTerminalSessionStateSaveFailure,
  isTerminalSessionStorageCapacityFailure
} from './terminal-session-state-save-failure'

describe('terminal save failure classification', () => {
  it.each(['ENOSPC', 'EDQUOT', 'SQLITE_FULL'])('recognizes %s through a wrapper', (code) => {
    const message = createTerminalSessionStateSaveFailureMessage(
      new Error('write failed', { cause: Object.assign(new Error('failure'), { code }) })
    )
    expect(isTerminalSessionStorageCapacityFailure(message)).toBe(true)
    expect(isTerminalSessionStateSaveFailure(message)).toBe(true)
  })

  it.each(['EACCES', 'EPERM', 'EIO', 'SQLITE_BUSY', 'profile-state-writer-exit'])(
    'does not diagnose %s as exhausted storage',
    (code) => {
      const message = createTerminalSessionStateSaveFailureMessage({ code, message: 'disk full' })
      expect(isTerminalSessionStateSaveFailure(message)).toBe(true)
      expect(isTerminalSessionStorageCapacityFailure(message)).toBe(false)
    }
  )

  it('treats legacy and unknown host errors as unclassified', () => {
    for (const message of [
      'ORCA_TERMINAL_SESSION_STATE_SAVE_FAILED: local storage is unavailable.',
      'Failed to save terminal session state',
      createTerminalSessionStateSaveFailureMessage(new Error('disk full'))
    ]) {
      expect(isTerminalSessionStateSaveFailure(message)).toBe(true)
      expect(isTerminalSessionStorageCapacityFailure(message)).toBe(false)
    }
  })

  it('handles cyclic causes', () => {
    const error = new Error('cycle')
    error.cause = error
    expect(
      isTerminalSessionStorageCapacityFailure(createTerminalSessionStateSaveFailureMessage(error))
    ).toBe(false)
  })
})
