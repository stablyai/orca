import {
  getSelectedDeletableWorkspaceIds,
  getVisibleDeletableWorkspaceIdentities,
  getWorkspaceSpaceWorktreeIdentity
} from './workspace-space-delete-selection'
import { describe, expect, it } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import {
  WORKSPACE_SPACE_FILTER_QUERY_MAX_BYTES,
  countWorkspaceSpaceActiveAgents,
  filterWorkspaceSpaceRows,
  getLargestWorkspaceSpaceItemSize,
  getLargestWorkspaceSpaceRowSize,
  isWorkspaceSpaceFilterQueryTooLarge,
  isWorkspaceSpaceRowReadyToDelete,
  pruneWorkspaceSpaceSelectedIds,
  resolveWorkspaceSpaceInspectedWorktreeId,
  resolveWorkspaceSpaceTreemapZoomWorktreeId,
  sortWorkspaceSpaceRows
} from './workspace-space-presentation'
import { getWorkspaceSpaceGitStatusRefreshCandidates } from './workspace-space-git-status-order'
import { getWorkspaceDecisionDetails } from './workspace-space-decision-details'
import {
  getWorkspaceSpaceDeleteState,
  getWorkspaceSpaceGitStatusForScan
} from './workspace-space-state-resolution'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { composeWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'

function row(overrides: Partial<WorkspaceSpaceWorktree>): WorkspaceSpaceWorktree {
  return {
    worktreeId: 'wt',
    repoId: 'repo',
    repoDisplayName: 'repo',
    repoPath: '/repo',
    displayName: 'workspace',
    path: '/workspace',
    branch: 'refs/heads/main',
    isMainWorktree: false,
    isRemote: false,
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 0,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0,
    ...overrides
  }
}

describe('workspace space Git status scan ownership', () => {
  it('fails closed instead of reusing a clean result from an older scan', () => {
    const cleanStatus = new Map([['local|wt', []]])

    expect(getWorkspaceSpaceGitStatusForScan(100, 100, cleanStatus)).toBe(cleanStatus)
    expect(getWorkspaceSpaceGitStatusForScan(100, 200, cleanStatus).has('local|wt')).toBe(false)
  })
})

function ready(
  overrides: Partial<NonNullable<Parameters<typeof isWorkspaceSpaceRowReadyToDelete>[1]>> = {}
) {
  return {
    isActive: false,
    changedFileCount: 0,
    dirtyEditorBufferCount: 0,
    activeAgentCount: 0,
    liveTerminalCount: 0,
    browserTabCount: 0,
    reviewLabel: null,
    issueLabel: null,
    linearIssueLabel: null,
    ...overrides
  }
}

function activeAgent(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'working',
    prompt: '',
    updatedAt: 1_000,
    stateStartedAt: 1_000,
    paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
    stateHistory: [],
    ...overrides
  }
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

function worktreeRecord(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt',
    repoId: 'repo',
    path: '/workspace',
    displayName: 'workspace',
    branch: 'refs/heads/feature/local',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function decisionInputs(
  overrides: Partial<Parameters<typeof getWorkspaceDecisionDetails>[1]> = {}
): Parameters<typeof getWorkspaceDecisionDetails>[1] {
  const defaultRepo = repo()
  const defaultWorktree = worktreeRecord()
  return {
    repoMap: new Map([[defaultRepo.id, defaultRepo]]),
    worktreeMap: new Map([[defaultWorktree.id, defaultWorktree]]),
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    agentStatusByPaneKey: {},
    migrationUnsupportedByPtyId: {},
    runtimePaneTitlesByTabId: {},
    retainedAgentsByPaneKey: {},
    openFiles: [],
    editorDrafts: {},
    browserTabsByWorktree: {},
    gitStatusByWorktree: {},
    remoteStatusesByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    settings: null,
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    now: 1_000,
    ...overrides
  }
}

describe('workspace space presentation helpers', () => {
  it('marks only the active host row active when workspace ids collide', () => {
    const inputs = decisionInputs({
      activeWorktreeId: 'wt',
      activeWorkspaceExecutionHostId: 'local',
      gitStatusByWorktree: { wt: [] }
    })
    const local = getWorkspaceDecisionDetails(
      row({ worktreeId: 'wt', executionHostId: 'local' }),
      inputs
    )
    const ssh = getWorkspaceDecisionDetails(
      row({ worktreeId: 'wt', executionHostId: 'ssh:builder' }),
      inputs
    )

    expect(local.isActive).toBe(true)
    expect(ssh.isActive).toBe(false)
    expect(isWorkspaceSpaceRowReadyToDelete(row({ executionHostId: 'ssh:builder' }), ssh)).toBe(
      true
    )
  })

  it('fails closed when the active workspace host is unknown', () => {
    const details = getWorkspaceDecisionDetails(
      row({ worktreeId: 'wt', executionHostId: 'ssh:builder' }),
      decisionInputs({ activeWorktreeId: 'wt', activeWorkspaceExecutionHostId: null })
    )

    expect(details.isActive).toBe(true)
  })

  it("does not expose another host row's force-delete state", () => {
    const failedOnLocal = {
      isDeleting: false,
      error: 'changed files',
      canForceDelete: true,
      forceDeleteReason: 'dirty' as const,
      executionHostId: 'local' as const
    }
    const states = {
      [composeWorktreeHostIdentity('local', 'wt')]: failedOnLocal
    }

    expect(
      getWorkspaceSpaceDeleteState(row({ executionHostId: 'ssh:builder' }), states, true)
    ).toBeUndefined()
    expect(getWorkspaceSpaceDeleteState(row({ executionHostId: 'local' }), states, true)).toBe(
      failedOnLocal
    )
  })

  it('keeps clean and dirty same-id rows isolated by host', () => {
    const localRow = row({ worktreeId: 'wt', executionHostId: 'local' })
    const sshRow = row({ worktreeId: 'wt', executionHostId: 'ssh:builder' })
    const statuses = new Map([
      [getWorkspaceSpaceWorktreeIdentity(localRow), []],
      [getWorkspaceSpaceWorktreeIdentity(sshRow), [{ path: 'dirty.txt' }]]
    ])
    const inputs = decisionInputs({ gitStatusByWorktreeIdentity: statuses })
    const local = getWorkspaceDecisionDetails(localRow, inputs)
    const ssh = getWorkspaceDecisionDetails(sshRow, inputs)

    expect(local.changedFileCount).toBe(0)
    expect(ssh.changedFileCount).toBe(1)
    expect(isWorkspaceSpaceRowReadyToDelete(localRow, local)).toBe(true)
    expect(isWorkspaceSpaceRowReadyToDelete(sshRow, ssh)).toBe(false)
  })

  it('sorts rows by the selected key and direction', () => {
    const rows = [
      row({ worktreeId: 'small', displayName: 'Small', sizeBytes: 10 }),
      row({ worktreeId: 'large', displayName: 'Large', sizeBytes: 100 }),
      row({ worktreeId: 'mid', displayName: 'Mid', sizeBytes: 50 })
    ]

    expect(sortWorkspaceSpaceRows(rows, 'size', 'desc').map((item) => item.worktreeId)).toEqual([
      'large',
      'mid',
      'small'
    ])
    expect(sortWorkspaceSpaceRows(rows, 'name', 'asc').map((item) => item.worktreeId)).toEqual([
      'large',
      'mid',
      'small'
    ])
  })

  it('filters by search text and deletable status', () => {
    const rows = [
      row({ worktreeId: 'a', displayName: 'Frontend Cache', repoDisplayName: 'app' }),
      row({ worktreeId: 'b', displayName: 'Main', repoDisplayName: 'api', canDelete: false })
    ]

    expect(filterWorkspaceSpaceRows(rows, 'cache', false).map((item) => item.worktreeId)).toEqual([
      'a'
    ])
    expect(filterWorkspaceSpaceRows(rows, '', true).map((item) => item.worktreeId)).toEqual(['a'])
  })

  it('rejects oversized pasted filters before reading workspace rows', () => {
    const oversizedQuery = 'secret-workspace-space'.repeat(WORKSPACE_SPACE_FILTER_QUERY_MAX_BYTES)
    const rows = [
      {
        get canDelete(): boolean {
          throw new Error('oversized workspace-space filters must not check delete state')
        },
        get displayName(): string {
          throw new Error('oversized workspace-space filters must not scan names')
        }
      }
    ] as WorkspaceSpaceWorktree[]

    expect(isWorkspaceSpaceFilterQueryTooLarge(oversizedQuery)).toBe(true)
    expect(filterWorkspaceSpaceRows(rows, oversizedQuery, true)).toEqual([])
  })

  it('rejects oversized whitespace before trimming', () => {
    const rows = [row({ worktreeId: 'a', displayName: 'Frontend Cache' })]

    expect(
      filterWorkspaceSpaceRows(rows, ' '.repeat(WORKSPACE_SPACE_FILTER_QUERY_MAX_BYTES + 1), false)
    ).toEqual([])
  })

  it('finds largest sizes without spreading large workspace arrays', () => {
    const rows = Array.from({ length: 130_000 }, (_, index) =>
      row({ worktreeId: `wt-${index}`, sizeBytes: index === 87_654 ? 999_999 : index })
    )
    const items = Array.from({ length: 130_000 }, (_, index) => ({
      name: `item-${index}`,
      path: `/repo/item-${index}`,
      kind: 'directory' as const,
      sizeBytes: index === 12_345 ? 888_888 : index
    }))

    expect(getLargestWorkspaceSpaceRowSize(rows)).toBe(999_999)
    expect(getLargestWorkspaceSpaceItemSize(items)).toBe(888_888)
    expect(getLargestWorkspaceSpaceRowSize([])).toBe(0)
    expect(getLargestWorkspaceSpaceItemSize([])).toBe(0)
  })

  it('returns only selected worktrees that can be deleted', () => {
    const rows = [
      row({ worktreeId: 'ok', canDelete: true, status: 'ok' }),
      row({ worktreeId: 'main', canDelete: false, status: 'ok' }),
      row({ worktreeId: 'failed', canDelete: true, status: 'error' })
    ]

    expect(
      getSelectedDeletableWorkspaceIds(rows, new Set(rows.map(getWorkspaceSpaceWorktreeIdentity)))
    ).toEqual(['ok'])
  })

  it('excludes rows that are already deleting from delete actions', () => {
    const rows = [
      row({ worktreeId: 'idle', canDelete: true, status: 'ok' }),
      row({ worktreeId: 'deleting', canDelete: true, status: 'ok' })
    ]
    const isDeleting = (worktree: WorkspaceSpaceWorktree): boolean =>
      worktree.worktreeId === 'deleting'

    expect(getVisibleDeletableWorkspaceIdentities(rows, isDeleting)).toEqual([
      getWorkspaceSpaceWorktreeIdentity(rows[0])
    ])
    expect(
      getSelectedDeletableWorkspaceIds(
        rows,
        new Set(rows.map(getWorkspaceSpaceWorktreeIdentity)),
        isDeleting
      )
    ).toEqual(['idle'])
  })

  it('treats open browser tabs as active workspace usage for deletion readiness', () => {
    const workspace = row({ worktreeId: 'with-browser', canDelete: true, status: 'ok' })

    expect(isWorkspaceSpaceRowReadyToDelete(workspace, ready())).toBe(true)
    expect(isWorkspaceSpaceRowReadyToDelete(workspace, ready({ browserTabCount: 1 }))).toBe(false)
  })

  it('counts hookless title-derived running agents as active workspace usage', () => {
    const count = countWorkspaceSpaceActiveAgents({
      worktreeId: 'wt',
      tabs: [{ id: 'tab-1', title: 'Codex working' }],
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      now: 1_000
    })

    expect(count).toBe(1)
  })

  it('does not count title-derived agents when the terminal has no live pty', () => {
    const count = countWorkspaceSpaceActiveAgents({
      worktreeId: 'wt',
      tabs: [{ id: 'tab-1', title: 'Codex working' }],
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {},
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      now: 1_000
    })

    expect(count).toBe(0)
  })

  it('counts fresh explicit active agents and ignores stale active entries', () => {
    expect(
      countWorkspaceSpaceActiveAgents({
        worktreeId: 'wt',
        tabs: [{ id: 'tab-1', title: 'Terminal' }],
        agentStatusByPaneKey: {
          [activeAgent().paneKey]: activeAgent()
        },
        migrationUnsupportedByPtyId: {},
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: {},
        now: 1_000
      })
    ).toBe(1)

    expect(
      countWorkspaceSpaceActiveAgents({
        worktreeId: 'wt',
        tabs: [{ id: 'tab-1', title: 'Terminal' }],
        agentStatusByPaneKey: {
          [activeAgent().paneKey]: activeAgent({ updatedAt: 1_000 })
        },
        migrationUnsupportedByPtyId: {},
        runtimePaneTitlesByTabId: {},
        ptyIdsByTabId: {},
        now: 60 * 60 * 1_000
      })
    ).toBe(0)
  })

  it('reads review and issue details from local owner cache while a runtime is focused', () => {
    const details = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: { number: 12, state: 'open', status: 'success', title: 'Local owner PR' }
          },
          'runtime:env-1::repo::feature/local': {
            data: { number: 99, state: 'open', status: 'failure', title: 'Runtime fallback PR' }
          }
        },
        issueCache: {
          'repo::123': {
            data: { number: 123, title: 'Local owner issue', state: 'open' }
          },
          'runtime:env-1::repo::123': {
            data: { number: 123, title: 'Runtime fallback issue', state: 'closed' }
          }
        },
        worktreeMap: new Map([
          ['wt', worktreeRecord({ branch: 'refs/heads/feature/local', linkedIssue: 123 })]
        ])
      })
    )

    expect(details.reviewLabel).toBe('PR #12 Open, success')
    expect(details.issueLabel).toBe('#123 open: Local owner issue')
  })

  it('hides a GitHub review explicitly suppressed after unlinking', () => {
    const details = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: {
              number: 12,
              state: 'open',
              status: 'success',
              title: 'Suppressed review',
              provider: 'github'
            }
          }
        },
        worktreeMap: new Map([
          ['wt', worktreeRecord({ branch: 'refs/heads/feature/local', suppressedGitHubPR: 12 })]
        ])
      })
    )

    expect(details.reviewLabel).toBeNull()
  })

  it('hides only a matching suppressed GitHub review from workspace decisions', () => {
    const matching = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: {
              provider: 'github',
              number: 12,
              state: 'open',
              status: 'success',
              title: 'Suppressed PR'
            }
          }
        },
        worktreeMap: new Map([
          [
            'wt',
            worktreeRecord({
              branch: 'refs/heads/feature/local',
              linkedPR: null,
              suppressedGitHubPR: 12
            })
          ]
        ])
      })
    )
    const different = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: {
              provider: 'github',
              number: 13,
              state: 'open',
              status: 'success',
              title: 'Different PR'
            }
          }
        },
        worktreeMap: new Map([
          [
            'wt',
            worktreeRecord({
              branch: 'refs/heads/feature/local',
              linkedPR: null,
              suppressedGitHubPR: 12
            })
          ]
        ])
      })
    )

    expect(matching.reviewLabel).toBeNull()
    expect(different.reviewLabel).toBe('PR #13 Open, success')
  })

  it('preserves explicit links and non-GitHub reviews in workspace decisions', () => {
    const cachedReview = {
      number: 12,
      state: 'open',
      status: 'success',
      title: 'Review'
    }
    const explicit = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: { ...cachedReview, provider: 'github' }
          }
        },
        worktreeMap: new Map([
          [
            'wt',
            worktreeRecord({
              branch: 'refs/heads/feature/local',
              linkedPR: 12,
              suppressedGitHubPR: 12
            })
          ]
        ])
      })
    )
    const gitLab = getWorkspaceDecisionDetails(
      row({ branch: 'refs/heads/feature/local' }),
      decisionInputs({
        hostedReviewCache: {
          'local::repo::feature/local': {
            data: { ...cachedReview, provider: 'gitlab' }
          }
        },
        worktreeMap: new Map([
          [
            'wt',
            worktreeRecord({
              branch: 'refs/heads/feature/local',
              linkedPR: null,
              suppressedGitHubPR: 12,
              linkedGitLabMR: 12
            })
          ]
        ])
      })
    )

    expect(explicit.reviewLabel).toBe('PR #12 Open, success')
    expect(gitLab.reviewLabel).toBe('PR #12 Open, success')
  })

  it('counts migration-unsupported agent entries by worktree id', () => {
    const count = countWorkspaceSpaceActiveAgents({
      worktreeId: 'wt',
      tabs: [],
      agentStatusByPaneKey: {},
      migrationUnsupportedByPtyId: {
        'pty-1': {
          ptyId: 'pty-1',
          worktreeId: 'wt',
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 1_000
        }
      },
      runtimePaneTitlesByTabId: {},
      ptyIdsByTabId: {},
      now: 1_000
    })

    expect(count).toBe(1)
  })

  it('returns every refreshable git-status row without a first-page cap', () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      row({ worktreeId: `wt-${index}`, isMainWorktree: false, canDelete: true, status: 'ok' })
    )

    expect(
      getWorkspaceSpaceGitStatusRefreshCandidates(rows).map((item) => item.worktreeId)
    ).toEqual(rows.map((item) => item.worktreeId))
  })

  it('orders git-status refreshes active first, then visible, then the rest', () => {
    const rows = [
      row({ worktreeId: 'rest-a', executionHostId: 'local' }),
      row({ worktreeId: 'visible-a', executionHostId: 'local' }),
      row({ worktreeId: 'active', executionHostId: 'ssh:builder' }),
      row({ worktreeId: 'visible-b', executionHostId: 'local' }),
      row({ worktreeId: 'rest-b', executionHostId: 'local' })
    ]
    const visibleWorktreeIdentities = new Set(
      [rows[1], rows[3]].map(getWorkspaceSpaceWorktreeIdentity)
    )

    expect(
      getWorkspaceSpaceGitStatusRefreshCandidates(rows, {
        activeWorktreeId: 'active',
        activeExecutionHostId: 'ssh:builder',
        visibleWorktreeIdentities
      }).map((item) => item.worktreeId)
    ).toEqual(['active', 'visible-a', 'visible-b', 'rest-a', 'rest-b'])
  })

  it('resolves inspected worktree ids from the current scan rows', () => {
    const rows = [
      row({ worktreeId: 'errored', status: 'error' }),
      row({ worktreeId: 'ready', status: 'ok' })
    ]

    expect(resolveWorkspaceSpaceInspectedWorktreeId(rows, '|errored')).toBe('|errored')
    expect(resolveWorkspaceSpaceInspectedWorktreeId(rows, '|missing')).toBe('|ready')
    expect(resolveWorkspaceSpaceInspectedWorktreeId([], '|missing')).toBeNull()
  })

  it('keeps treemap zoom only for ready current scan rows', () => {
    const rows = [
      row({ worktreeId: 'ready', status: 'ok' }),
      row({ worktreeId: 'errored', status: 'error' })
    ]

    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, '|ready')).toBe('|ready')
    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, '|errored')).toBeNull()
    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, '|missing')).toBeNull()
  })

  it('prunes selected workspace ids that are absent from the current scan', () => {
    const selectedIds = new Set(['|ready', '|missing'])
    const pruned = pruneWorkspaceSpaceSelectedIds([row({ worktreeId: 'ready' })], selectedIds)

    expect([...pruned]).toEqual(['|ready'])
    expect(pruned).not.toBe(selectedIds)

    const unchanged = pruneWorkspaceSpaceSelectedIds([row({ worktreeId: 'ready' })], pruned)
    expect(unchanged).toBe(pruned)
  })
})
