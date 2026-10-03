import { describe, expect, it } from 'vitest'
import { claudePinnedLaunchError } from '../../../../shared/claude/claude-pinned-launch-error'
import { describeClaudePinnedLaunchError } from './claude-pinned-launch-error-copy'

describe('describeClaudePinnedLaunchError', () => {
  it.each([
    [
      'host-sessions',
      'This Claude account is still used by terminals started while it was the active account. Close them, or start on the active account this time.',
      true
    ],
    ['host-mutation', 'Claude accounts are being updated. Try again in a moment.', false],
    ['usage-fetch', 'Checking account usage took too long. Try again.', false],
    [
      'account-missing',
      'The saved Claude account for this project is no longer signed in. Change it in Settings → Repository, or start on the active account.',
      true
    ],
    ['became-active', 'That account just became the active account. Try again.', false],
    [
      'credentials',
      'This Claude account needs to sign in again. Re-authenticate it in Settings → Accounts.',
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
    expect(describeClaudePinnedLaunchError(error)).toMatchObject({ message, offerActiveAccount })
  })

  it('offers Retry only for refusals that clear on their own', () => {
    const offersRetry = (code: Parameters<typeof claudePinnedLaunchError>[0]) =>
      describeClaudePinnedLaunchError(claudePinnedLaunchError(code, 'refused').message)?.offerRetry
    expect(offersRetry('host-mutation')).toBe(true)
    expect(offersRetry('usage-fetch')).toBe(true)
    expect(offersRetry('became-active')).toBe(true)
    expect(offersRetry('host-sessions')).toBe(false)
    expect(offersRetry('credentials')).toBe(false)
  })

  it('returns null for an unrelated error', () => {
    expect(describeClaudePinnedLaunchError('Paste failed.')).toBeNull()
  })

  it('names the account and its terminal count when the refusal carries them', () => {
    const error = claudePinnedLaunchError('host-sessions', 'in use', {
      email: 'work@example.com',
      terminalCount: 2
    }).message
    expect(describeClaudePinnedLaunchError(error)?.message).toBe(
      'work@example.com is still used by 2 Claude terminals started while it was the active account. Close them, or start on the active account this time.'
    )
  })
})
