import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import {
  createSleepingSweepRetentionState,
  updateSleepingSweepRetention
} from './sleeping-sweep-retention'
import { hasActiveWorkspaceActivity } from '@/lib/worktree-activity-state'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'

/**
 * Repro for #15996 — a remote workspace's sidebar row blinks out for one frame
 * when another workspace is activated.
 *
 * A remote pane rebinding its PTY empties `ptyIdsByTabId[tabId]` for a commit.
 * The workspace's agent finished its turn long ago, so `worktreeIdsWithLiveAgent`
 * does not hold the row either, and "Hide sleeping" sweeps it out and back in
 * consecutive renders — the list jumps a full row height and snaps back.
 */

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0 }
}

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo1',
    path: `/tmp/${id}`,
    head: 'abc123',
    branch: `refs/heads/${id}`,
    isBare: false,
    isMainWorktree: false,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

const REMOTE = 'wt-dragfiles-remote'
const OTHER = 'wt-resources-remote'
const worktrees = [makeWorktree(REMOTE), makeWorktree(OTHER)]
const sortedIds = worktrees.map((w) => w.id)
const repoMap = new Map<string, Repo>([['repo1', makeRepo('repo1')]])

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

/** Both workspaces hold one open terminal tab; neither has a fresh agent. */
const tabsByWorktree = {
  [REMOTE]: [{ id: 'tab-remote' }],
  [OTHER]: [{ id: 'tab-other' }]
}

function visibleOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: false,
    tabsByWorktree,
    ptyIdsByTabId: { 'tab-remote': ['remote:pty-1'], 'tab-other': ['remote:pty-2'] },
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set<string>(),
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    pairedDeviceIdsByEnvironment: new Map(),
    repoMap,
    workspaceHostScope: 'all',
    defaultHostId: LOCAL_EXECUTION_HOST_ID,
    worktreeLineageById: {},
    ...overrides
  }
}

/** Mirrors what useVisibleSidebarWorktrees does per pass. */
function sweepPass(
  state: ReturnType<typeof createSleepingSweepRetentionState>,
  ptyIdsByTabId: Record<string, string[]>,
  nowMs: number
): string[] {
  const worktreeIdsWithLiveAgent = new Set<string>()
  const { retainedIds } = updateSleepingSweepRetention({
    state,
    candidateWorktreeIds: sortedIds,
    isActive: (worktreeId) =>
      hasActiveWorkspaceActivity(
        worktreeId,
        tabsByWorktree,
        ptyIdsByTabId,
        {},
        worktreeIdsWithLiveAgent
      ),
    nowMs
  })
  return computeVisibleWorktreeIds(
    { repo1: worktrees },
    sortedIds,
    visibleOptions({ ptyIdsByTabId, sleepingSweepExemptWorktreeIds: retainedIds })
  )
}

describe('#15996 transient PTY gap under "Hide sleeping"', () => {
  it('keeps the row through a one-commit gap in ptyIdsByTabId', () => {
    const state = createSleepingSweepRetentionState()
    const bound = { 'tab-remote': ['remote:pty-1'], 'tab-other': ['remote:pty-2'] }
    // The rebind commit — clearPtyBinding sets the tab's live PTY list to [].
    const rebinding = { 'tab-remote': [], 'tab-other': ['remote:pty-2'] }

    expect(sweepPass(state, bound, 1_000)).toEqual([REMOTE, OTHER])
    expect(sweepPass(state, rebinding, 1_016)).toEqual([REMOTE, OTHER])
    expect(sweepPass(state, bound, 1_032)).toEqual([REMOTE, OTHER])
  })

  it('still sweeps the row once the workspace is genuinely asleep', () => {
    const state = createSleepingSweepRetentionState()
    const bound = { 'tab-remote': ['remote:pty-1'], 'tab-other': ['remote:pty-2'] }
    const closed = { 'tab-remote': [], 'tab-other': ['remote:pty-2'] }

    expect(sweepPass(state, bound, 1_000)).toEqual([REMOTE, OTHER])
    expect(sweepPass(state, closed, 1_100)).toEqual([REMOTE, OTHER])
    expect(sweepPass(state, closed, 10_000)).toEqual([OTHER])
  })

  it('does not let a grace window outrank the repo filter', () => {
    const state = createSleepingSweepRetentionState()
    const bound = { 'tab-remote': ['remote:pty-1'], 'tab-other': ['remote:pty-2'] }
    const rebinding = { 'tab-remote': [], 'tab-other': ['remote:pty-2'] }

    sweepPass(state, bound, 1_000)
    const { retainedIds } = updateSleepingSweepRetention({
      state,
      candidateWorktreeIds: sortedIds,
      isActive: (worktreeId) =>
        hasActiveWorkspaceActivity(worktreeId, tabsByWorktree, rebinding, {}, new Set()),
      nowMs: 1_016
    })
    expect([...retainedIds]).toEqual([REMOTE])

    const visible = computeVisibleWorktreeIds(
      { repo1: worktrees },
      sortedIds,
      visibleOptions({
        ptyIdsByTabId: rebinding,
        sleepingSweepExemptWorktreeIds: retainedIds,
        filterRepoIds: ['repo-other']
      })
    )
    expect(visible).toEqual([])
  })
})
