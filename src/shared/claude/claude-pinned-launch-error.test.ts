import { describe, expect, it } from 'vitest'
import {
  claudePinnedLaunchError,
  readClaudePinnedLaunchErrorCode,
  stripClaudePinnedLaunchMarker
} from './claude-pinned-launch-error'

describe('claude pinned launch error marker', () => {
  it('round-trips the code through an IPC-wrapped message', () => {
    const error = claudePinnedLaunchError(
      'account-missing',
      'That Claude account no longer exists.'
    )
    const wrapped = `Error invoking remote method 'pty:spawn': Error: ${error.message}`
    expect(readClaudePinnedLaunchErrorCode(wrapped)).toBe('account-missing')
    expect(error.message).toContain('That Claude account no longer exists.')
  })

  it('ignores unrelated errors and unknown codes', () => {
    expect(readClaudePinnedLaunchErrorCode('ENOENT')).toBeNull()
    expect(readClaudePinnedLaunchErrorCode('[claude_pinned:bogus]')).toBeNull()
  })

  it('strips the marker for display and leaves other text alone', () => {
    const error = claudePinnedLaunchError('unsupported-host', 'Not supported in WSL.')
    expect(stripClaudePinnedLaunchMarker(`Launch failed: ${error.message}`)).toBe(
      'Launch failed: Not supported in WSL.'
    )
    expect(stripClaudePinnedLaunchMarker('ENOENT [other]')).toBe('ENOENT [other]')
  })
})
