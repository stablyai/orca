import { describe, expect, it } from 'vitest'
import { classifyWorktreeForceDeleteReason, WORKTREE_TEARDOWN_FORCE_HINT } from './worktree-removal'

// Why (#11960): the desktop Force Delete button renders only when this classifier
// returns a reason. The PTY-teardown error tells the user to force-delete, so an
// unclassified message leaves them reading advice they cannot act on.
describe('classifyWorktreeForceDeleteReason for unstopped PTYs', () => {
  const liveError = `Failed to physically stop every PTY for worktree: repo-1::/w — still live: term_a. ${WORKTREE_TEARDOWN_FORCE_HINT}`
  const unverifiableError = `Failed to physically stop every PTY for worktree: repo-1::/w — could not verify these exited: term_a (daemon socket closed). ${WORKTREE_TEARDOWN_FORCE_HINT}`

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

  it('leaves unrelated failures unclassified', () => {
    expect(classifyWorktreeForceDeleteReason('some other failure')).toBeNull()
  })
})
