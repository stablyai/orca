import { describe, expect, it } from 'vitest'
import {
  claudePinnedLaunchError,
  readClaudePinnedLaunchErrorCode,
  readClaudePinnedLaunchErrorDetails,
  stripClaudePinnedLaunchMarker
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

  it('carries the account email and terminal count through the marker', () => {
    const error = claudePinnedLaunchError('host-sessions', 'in use', {
      email: 'a b]@c.d',
      terminalCount: 2
    })
    const wrapped = `Error invoking remote method 'pty:spawn': Error: ${error.message}`
    expect(readClaudePinnedLaunchErrorCode(wrapped)).toBe('host-sessions')
    expect(readClaudePinnedLaunchErrorDetails(wrapped)).toEqual({
      email: 'a b]@c.d',
      terminalCount: 2
    })
  })

  it('drops malformed marker details', () => {
    expect(
      readClaudePinnedLaunchErrorDetails('[claude_pinned:host-sessions email=%E0%A4%A terminals=x]')
    ).toEqual({})
    expect(readClaudePinnedLaunchErrorDetails('[claude_pinned:host-sessions]')).toEqual({})
  })

  it('strips the marker for display and leaves other text alone', () => {
    const error = claudePinnedLaunchError('host-sessions', 'Account a@b.c is in use.', {
      email: 'a@b.c',
      terminalCount: 1
    })
    expect(stripClaudePinnedLaunchMarker(`Launch failed: ${error.message}`)).toBe(
      'Launch failed: Account a@b.c is in use.'
    )
    expect(stripClaudePinnedLaunchMarker('ENOENT [other]')).toBe('ENOENT [other]')
  })
})
