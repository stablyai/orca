import { describe, expect, it } from 'vitest'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { shouldPreserveCleanupInspection } from './workspace-cleanup-local-evidence'
import {
  WORKTREE_ID,
  makeCandidate,
  makeState
} from './workspace-cleanup-slice-test-harness'

describe('cleanup inspection grace survives upgrades', () => {
  // Why: viewed marks are persisted. Any extra field required of `viewed` is
  // absent from every entry written by an older build, so gating on one
  // silently voids the grace period for existing users after they update.
  it('honours a viewed mark persisted without any newer fields', () => {
    const candidate = makeCandidate({ fingerprint: 'fingerprint-1' })
    const state = makeState({
      workspaceCleanupViewedCandidates: {
        [WORKTREE_ID]: { viewedAt: Date.now(), fingerprint: 'fingerprint-1' }
      }
    })

    expect(shouldPreserveCleanupInspection(candidate, state)).toBe(true)
  })

  it('still drops the grace once the row fingerprint changes', () => {
    const candidate = makeCandidate({ fingerprint: 'fingerprint-2' })
    const state = makeState({
      workspaceCleanupViewedCandidates: {
        [WORKTREE_ID]: { viewedAt: Date.now(), fingerprint: 'fingerprint-1' }
      }
    })

    expect(shouldPreserveCleanupInspection(candidate, state)).toBe(false)
  })

  it('still expires the grace after the window', () => {
    const candidate = makeCandidate({ fingerprint: 'fingerprint-1' })
    const state = makeState({
      workspaceCleanupViewedCandidates: {
        [WORKTREE_ID]: {
          viewedAt: Date.now() - 3 * 60 * 60 * 1000,
          fingerprint: 'fingerprint-1'
        }
      }
    })

    expect(shouldPreserveCleanupInspection(candidate, state)).toBe(false)
  })
})

describe('cleanup reads visit recency host-qualified', () => {
  // Why: visits are STAMPED under `${hostId}|${worktreeId}` whenever the host is
  // known, which is the normal case including 'local'. A bare `map[worktreeId]`
  // read therefore misses every modern entry and silently yields 0.
  it('finds a visit stamped under the host-qualified key', async () => {
    const { enrichWorkspaceCleanupCandidates } = await import('./workspace-cleanup')
    const qualifiedKey = composeWorktreeHostIdentity('local', WORKTREE_ID)
    expect(qualifiedKey).not.toBe(WORKTREE_ID)

    const [candidate] = await enrichWorkspaceCleanupCandidates(
      [makeCandidate()],
      makeState({
        lastVisitedAtByWorktreeId: { [qualifiedKey]: Date.now() },
        browserTabsByWorktree: { [WORKTREE_ID]: [{ id: 'tab-1' }] } as never
      }),
      { applyDismissals: false }
    )

    expect(candidate.blockers).toContain('recent-visible-context')
  })
})
