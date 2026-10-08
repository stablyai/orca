import { describe, expect, it } from 'vitest'
import { claudePinnedLaunchError } from '../../../../shared/claude/claude-pinned-launch-error'
import { describeClaudePinnedLaunchError } from './claude-pinned-launch-error-copy'

describe('describeClaudePinnedLaunchError', () => {
  it.each([
    [
      'account-missing',
      'The saved Claude account for this project is no longer signed in. Change it in Settings → Repository, or start on the active account.',
      true
    ],
    [
      'provenance',
      "Couldn't confirm the Claude account for this session, so it wasn't started.",
      false
    ],
    [
      'unsupported-host',
      "A saved Claude account can't be used in WSL yet. Start on the active account, or set this project's account to Default in Settings → Repository.",
      true
    ]
  ] as const)('maps %s to its message and offer flag', (code, message, offerActiveAccount) => {
    const error = claudePinnedLaunchError(code, 'refused').message
    expect(describeClaudePinnedLaunchError(error)).toEqual({ message, offerActiveAccount })
  })

  it('returns null for an unrelated error', () => {
    expect(describeClaudePinnedLaunchError('Paste failed.')).toBeNull()
  })
})
