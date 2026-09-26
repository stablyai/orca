import { describe, expect, it } from 'vitest'
import {
  claudePinnedLaunchError,
  readClaudePinnedLaunchErrorCode
} from './claude-pinned-launch-error'

describe('claude pinned launch error marker', () => {
  it('round-trips the code through an IPC-wrapped message', () => {
    const error = claudePinnedLaunchError(
      'host-sessions',
      'Account a@b.c still has 2 Claude terminals.'
    )
    const wrapped = `Error invoking remote method 'pty:spawn': Error: ${error.message}`
    expect(readClaudePinnedLaunchErrorCode(wrapped)).toBe('host-sessions')
    expect(error.message).toContain('Account a@b.c still has 2 Claude terminals.')
  })

  it('ignores unrelated errors and unknown codes', () => {
    expect(readClaudePinnedLaunchErrorCode('ENOENT')).toBeNull()
    expect(readClaudePinnedLaunchErrorCode('[claude_pinned:bogus]')).toBeNull()
  })
})
