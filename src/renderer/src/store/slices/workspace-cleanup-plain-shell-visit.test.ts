import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeTerminalTab } from '@/components/worktree-jump-palette-test-fixtures'
import { NOW, WORKTREE_ID, makeCandidate, makeState } from './workspace-cleanup-slice-test-harness'

vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const DAY_MS = 24 * 60 * 60 * 1000

// Plain-shell-only remote visits lack agent activity; host-owned start/exit stamps do not update Recent either.
function plainShellWorkspace(visitedDaysAgo: number) {
  const candidate = makeCandidate({
    executionHostId: 'ssh:box',
    lastActivityAt: NOW - 45 * DAY_MS,
    reasons: ['idle-clean']
  })
  const state = makeState({
    tabsByWorktree: { [WORKTREE_ID]: [makeTerminalTab('tab-1', WORKTREE_ID, 'zsh')] },
    lastVisitedAtByWorktreeId: {
      [composeWorktreeHostIdentity('ssh:box', WORKTREE_ID)]: NOW - visitedDaysAgo * DAY_MS
    }
  })
  return { candidate, state }
}

describe('cleanup reads a plain-shell workspace’s visits as activity (switch on)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a workspace visited two days ago is not idle, and shows that as its last activity', async () => {
    const { enrichWorkspaceCleanupCandidates } = await import('./workspace-cleanup')
    const { candidate, state } = plainShellWorkspace(2)
    const [enriched] = await enrichWorkspaceCleanupCandidates([candidate], state, {
      applyDismissals: false
    })
    expect(enriched.reasons).toEqual([])
    expect(enriched.lastActivityAt).toBe(NOW - 2 * DAY_MS)
    expect(enriched.selectedByDefault).toBe(false)
  })

  it('a workspace last visited 40 days ago is still idle', async () => {
    const { enrichWorkspaceCleanupCandidates } = await import('./workspace-cleanup')
    const { candidate, state } = plainShellWorkspace(40)
    const [enriched] = await enrichWorkspaceCleanupCandidates([candidate], state, {
      applyDismissals: false
    })
    expect(enriched.reasons).toEqual(['idle-clean'])
    expect(enriched.lastActivityAt).toBe(NOW - 40 * DAY_MS)
  })
})
