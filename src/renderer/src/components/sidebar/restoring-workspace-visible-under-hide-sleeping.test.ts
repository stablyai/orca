import { describe, expect, it } from 'vitest'
import { computeVisibleWorktreeIds } from './visible-worktrees'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

/**
 * Repro for #16247. Startup hydrates tabs before reconnect publishes any ptyId, so
 * under "Hide sleeping" every restored workspace briefly reads as asleep and its row
 * — and its project header — vanishes and returns.
 */

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0 }
}

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    ptyId,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
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

const repoMap = new Map<string, Repo>([['repo1', makeRepo('repo1')]])
const restoring = makeWorktree('restoring')
const slept = makeWorktree('slept')
const worktreesByRepo = { repo1: [restoring, slept] }
const sortedIds = ['restoring', 'slept']

type VisibleOptions = Parameters<typeof computeVisibleWorktreeIds>[2]

/** Mid-reconnect: tabs hydrated, no ptyId yet, so both rows look alike to the sweep. */
function midReconnectOptions(overrides: Partial<VisibleOptions> = {}): VisibleOptions {
  return {
    filterRepoIds: [],
    showSleepingWorkspaces: false,
    tabsByWorktree: {
      restoring: [makeTab('tab-restoring', 'restoring', null)],
      slept: [makeTab('tab-slept', 'slept', null)]
    },
    ptyIdsByTabId: { 'tab-restoring': [], 'tab-slept': [] },
    browserTabsByWorktree: {},
    worktreeIdsWithLiveAgent: new Set(),
    pendingReconnectWorktreeIds: new Set(),
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

describe('startup reconnect exemption under Hide sleeping', () => {
  it('keeps a workspace awaiting reconnect while dropping a genuinely slept one', () => {
    expect(
      computeVisibleWorktreeIds(
        worktreesByRepo,
        sortedIds,
        midReconnectOptions({ pendingReconnectWorktreeIds: new Set(['restoring']) })
      )
    ).toEqual(['restoring'])
  })

  it('drops both rows once reconnect drains the pending set without a live pty', () => {
    expect(computeVisibleWorktreeIds(worktreesByRepo, sortedIds, midReconnectOptions())).toEqual([])
  })

  it('does not change membership when the reconnected pty lands', () => {
    const duringReconnect = computeVisibleWorktreeIds(
      worktreesByRepo,
      sortedIds,
      midReconnectOptions({ pendingReconnectWorktreeIds: new Set(['restoring']) })
    )
    const afterReconnect = computeVisibleWorktreeIds(
      worktreesByRepo,
      sortedIds,
      midReconnectOptions({
        ptyIdsByTabId: { 'tab-restoring': ['pty-1'], 'tab-slept': [] }
      })
    )

    expect(duringReconnect).toEqual(['restoring'])
    // The row must not blink out between the exemption expiring and the pty landing.
    expect(afterReconnect).toEqual(duringReconnect)
  })

  it('leaves membership alone when Hide sleeping is off', () => {
    expect(
      computeVisibleWorktreeIds(
        worktreesByRepo,
        sortedIds,
        midReconnectOptions({
          showSleepingWorkspaces: true,
          pendingReconnectWorktreeIds: new Set(['restoring'])
        })
      )
    ).toEqual(sortedIds)
  })
})
