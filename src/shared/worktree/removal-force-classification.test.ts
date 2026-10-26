import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeForceDeleteReason,
  isProvenLivePtyRemovalError,
  UNSTOPPED_PTY_REMOVAL_PREFIX,
  WORKTREE_TEARDOWN_FORCE_HINT
} from './removal'

const liveError = `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo-1::/w — still live: term_a. ${WORKTREE_TEARDOWN_FORCE_HINT}`
const unverifiableError = `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo-1::/w — could not verify these exited: term_a (daemon socket closed). ${WORKTREE_TEARDOWN_FORCE_HINT}`

// The classifier controls Force Delete visibility; an unclassified teardown refusal hides the action its message recommends (#11960).
describe('classifyWorktreeForceDeleteReason for unstopped PTYs', () => {
  // Ordinary desktop confirmation already sets force to skip dirty prompts; it does not waive terminal-stop proof (#11960).
  it('still offers force when the failed attempt only set force', () => {
    expect(classifyWorktreeForceDeleteReason(liveError, true)).toBe('unstopped-pty')
  })

  it('does not re-offer force once the waiver itself was already used', () => {
    expect(classifyWorktreeForceDeleteReason(liveError, true, true)).toBeNull()
    expect(classifyWorktreeForceDeleteReason(liveError, false, true)).toBeNull()
  })

  // A timed-out sweep has no per-PTY verdict but needs the same explicit waiver affordance (#11960).
})

// Only Orca’s verdict may escalate the toast to killing live PTYs; user-chosen paths cannot supply it.
describe('isProvenLivePtyRemovalError', () => {
  it('reads the verdict Orca actually recorded', () => {
    expect(isProvenLivePtyRemovalError(liveError)).toBe(true)
    expect(isProvenLivePtyRemovalError(unverifiableError)).toBe(false)
  })

  it('does not let a worktree path spell out a live verdict', () => {
    expect(
      isProvenLivePtyRemovalError(
        `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo-1::/Users/dev/still live: notes — could not verify these exited: term_a (daemon socket closed)`
      )
    ).toBe(false)
  })
})
