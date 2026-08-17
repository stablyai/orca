import { describe, expect, it } from 'vitest'
import {
  classifyWorktreeForceDeleteReason,
  isProvenLivePtyRemovalError,
  UNSTOPPED_PTY_REMOVAL_PREFIX,
  WORKTREE_TEARDOWN_FORCE_HINT,
  WORKTREE_TEARDOWN_TIMEOUT_PREFIX
} from './removal'

const liveError = `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo-1::/w — still live: term_a. ${WORKTREE_TEARDOWN_FORCE_HINT}`
const unverifiableError = `${UNSTOPPED_PTY_REMOVAL_PREFIX} repo-1::/w — could not verify these exited: term_a (daemon socket closed). ${WORKTREE_TEARDOWN_FORCE_HINT}`

// Why (#11960): the desktop Force Delete button renders only when this classifier
// returns a reason. The PTY-teardown error tells the user to force-delete, so an
// unclassified message leaves them reading advice they cannot act on.
describe('classifyWorktreeForceDeleteReason for unstopped PTYs', () => {
  it('offers force for a PTY that is still live', () => {
    expect(classifyWorktreeForceDeleteReason(liveError)).toBe('unstopped-pty')
  })

  it('offers force when the stop could not be verified', () => {
    expect(classifyWorktreeForceDeleteReason(unverifiableError)).toBe('unstopped-pty')
  })

  // Why (#11960): the ordinary delete confirmation already passes force:true to skip
  // the dirty-file prompt. If that suppressed the offer, the most common desktop
  // delete would hit the gate with no Force Delete button anywhere — the original
  // dead end, restored.
  it('still offers force when the failed attempt only set force', () => {
    expect(classifyWorktreeForceDeleteReason(liveError, true)).toBe('unstopped-pty')
  })

  it('does not re-offer force once the waiver itself was already used', () => {
    expect(classifyWorktreeForceDeleteReason(liveError, true, true)).toBeNull()
    expect(classifyWorktreeForceDeleteReason(liveError, false, true)).toBeNull()
  })

  // Why: a wedged provider rejects the sweep before any per-PTY verdict exists, so the
  // failure arrives worded as a teardown timeout. The waiver clears it exactly like an
  // unproven stop, so leaving it unclassified hid the button for the wedge #11960 targeted.
  it('offers force when the teardown sweep itself timed out', () => {
    expect(
      classifyWorktreeForceDeleteReason(
        `${WORKTREE_TEARDOWN_TIMEOUT_PREFIX} repo-1::/w. ${WORKTREE_TEARDOWN_FORCE_HINT}`
      )
    ).toBe('unstopped-pty')
  })

  it('leaves unrelated failures unclassified', () => {
    expect(classifyWorktreeForceDeleteReason('some other failure')).toBeNull()
  })
})

// The live verdict escalates the delete toast to "Force Delete will kill them", so it must
// come from Orca's own detail — not from the worktree id, which is a user-chosen path.
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
