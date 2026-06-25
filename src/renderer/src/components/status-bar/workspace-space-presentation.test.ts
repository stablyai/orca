import { describe, expect, it } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import {
  WORKSPACE_SPACE_FILTER_QUERY_MAX_BYTES,
  countWorkspaceSpaceActiveAgents,
  filterWorkspaceSpaceRows,
  getLargestWorkspaceSpaceItemSize,
  getLargestWorkspaceSpaceRowSize,
  getSelectedDeletableWorkspaceIds,
  getVisibleDeletableWorkspaceIds,
  getWorkspaceSpaceGitStatusRefreshCandidates,
  isWorkspaceSpaceFilterQueryTooLarge,
  isWorkspaceSpaceRowReadyToDelete,
  pruneWorkspaceSpaceSelectedIds,
  resolveWorkspaceSpaceInspectedWorktreeId,
  resolveWorkspaceSpaceTreemapZoomWorktreeId,
  sortWorkspaceSpaceRows
} from './workspace-space-presentation'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

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

describe('workspace space presentation helpers', () => {
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

    expect(getSelectedDeletableWorkspaceIds(rows, new Set(['ok', 'main', 'failed']))).toEqual([
      'ok'
    ])
  })

  it('excludes rows that are already deleting from delete actions', () => {
    const rows = [
      row({ worktreeId: 'idle', canDelete: true, status: 'ok' }),
      row({ worktreeId: 'deleting', canDelete: true, status: 'ok' })
    ]
    const isDeleting = (worktreeId: string): boolean => worktreeId === 'deleting'

    expect(getVisibleDeletableWorkspaceIds(rows, isDeleting)).toEqual(['idle'])
    expect(
      getSelectedDeletableWorkspaceIds(rows, new Set(['idle', 'deleting']), isDeleting)
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

  it('resolves inspected worktree ids from the current scan rows', () => {
    const rows = [
      row({ worktreeId: 'errored', status: 'error' }),
      row({ worktreeId: 'ready', status: 'ok' })
    ]

    expect(resolveWorkspaceSpaceInspectedWorktreeId(rows, 'errored')).toBe('errored')
    expect(resolveWorkspaceSpaceInspectedWorktreeId(rows, 'missing')).toBe('ready')
    expect(resolveWorkspaceSpaceInspectedWorktreeId([], 'missing')).toBeNull()
  })

  it('keeps treemap zoom only for ready current scan rows', () => {
    const rows = [
      row({ worktreeId: 'ready', status: 'ok' }),
      row({ worktreeId: 'errored', status: 'error' })
    ]

    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, 'ready')).toBe('ready')
    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, 'errored')).toBeNull()
    expect(resolveWorkspaceSpaceTreemapZoomWorktreeId(rows, 'missing')).toBeNull()
  })

  it('prunes selected workspace ids that are absent from the current scan', () => {
    const selectedIds = new Set(['ready', 'missing'])
    const pruned = pruneWorkspaceSpaceSelectedIds([row({ worktreeId: 'ready' })], selectedIds)

    expect([...pruned]).toEqual(['ready'])
    expect(pruned).not.toBe(selectedIds)

    const unchanged = pruneWorkspaceSpaceSelectedIds([row({ worktreeId: 'ready' })], pruned)
    expect(unchanged).toBe(pruned)
  })
})
