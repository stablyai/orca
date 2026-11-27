import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { structuredAgentSessionPaneKey } from '../../../../../../shared/agent-session/view/structured-agent-session-projection'
import { worktreeWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { purgeHydratedWorktrees } from './hydrated-worktree-purge'
import type { WorktreeRefreshResult } from './worktree-refresh-result'
import { buildFullWorktreePurgeState } from '../teardown/worktree-purge-state'

describe('hydrated worktree purge across auxiliary session maps', () => {
  it('collects stale worktree keys from unifiedTabsByWorktree, activeTabTypeByWorktree, and contestedPrimaryHostBySessionKey while preserving uncovered SSH entries', () => {
    const liveId = 'repoA::/a/live'
    const staleUnified = 'repoA::/a/stale-unified'
    const staleActiveOnly = 'repoA::/a/stale-active-only'
    const staleContestedOnly = 'repoA::/a/stale-contested-only'
    const hiddenSsh = 'repo-hidden::/srv/app'
    const purged: unknown[] = []

    const state = {
      hasHydratedWorktreePurge: false,
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      repos: [{ id: 'repoA', path: '/repos/a', displayName: 'a', badgeColor: '#000', addedAt: 0 }],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      folderWorkspaces: [],
      wslMovedProjects: [],
      worktreeCatalogVersionByRepoHost: {},
      detectedWorktreesByRepo: {
        repoA: {
          authoritative: true,
          worktrees: [{ id: liveId, repoId: 'repoA', path: '/a/live' }]
        }
      },
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        [liveId]: [],
        [staleUnified]: []
      },
      activeTabTypeByWorktree: {
        [liveId]: 'terminal',
        [staleActiveOnly]: 'editor'
      },
      contestedPrimaryHostBySessionKey: {
        [liveId]: 'local',
        [staleContestedOnly]: 'local',
        [worktreeWorkspaceKey(staleUnified)]: 'local',
        [hiddenSsh]: 'ssh:hidden-target'
      },
      purgeWorktreeTerminalState: vi.fn((targets: unknown[]) => {
        purged.push(...targets)
      })
    } as unknown as AppState

    const set = vi.fn((patch: Partial<AppState>) => {
      Object.assign(state, patch)
    })
    const results = [
      {
        repoId: 'repoA',
        hostId: 'local',
        refresh: {
          result: {
            authoritative: true,
            worktrees: [{ id: liveId, repoId: 'repoA', path: '/a/live' }]
          }
        }
      }
    ] as unknown as WorktreeRefreshResult[]

    purgeHydratedWorktrees(set as never, () => state, results)

    expect(state.hasHydratedWorktreePurge).toBe(true)
    expect(new Set(purged)).toEqual(new Set([staleUnified, staleActiveOnly, staleContestedOnly]))
  })

  it('evicts contestedPrimaryHostBySessionKey and structuredChatSleptAtByPaneKey during worktree purge', () => {
    const liveId = 'repoA::/a/live'
    const staleId = 'repoA::/a/stale'
    const liveChatPane = structuredAgentSessionPaneKey('live-chat-tab', 'sess-live')
    const staleChatPane = structuredAgentSessionPaneKey('stale-chat-tab', 'sess-stale')
    const removedStatusEntries: (readonly [string, unknown])[] = []
    const agentStatusByPaneKey = {
      keys: () => [liveChatPane, staleChatPane].values(),
      replace(entries: Iterable<readonly [string, unknown]>) {
        removedStatusEntries.push(...entries)
        return this
      }
    }

    const state = {
      tabsByWorktree: {},
      unifiedTabsByWorktree: {
        [liveId]: [{ id: 'live-chat-tab', entityId: 'sess-live', contentType: 'agent-session' }],
        [staleId]: [{ id: 'stale-chat-tab', entityId: 'sess-stale', contentType: 'agent-session' }]
      },
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      tabBarOrderByWorktree: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      browserAnnotationsByPageId: {},
      browserAnnotationMarkerIdsByPageId: {},
      remoteBrowserPageHandlesByPageId: {},
      pendingAddressBarFocusByPageId: {},
      pendingAddressBarFocusByTabId: {},
      recentlyClosedBrowserPagesByWorkspace: {},
      openFiles: [],
      terminalLayoutsByTabId: {},
      ptyIdsByTabId: {},
      activeTabIdByWorktree: {},
      activeFileIdByWorktree: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: { [liveId]: 'terminal', [staleId]: 'terminal' },
      contestedPrimaryHostBySessionKey: {
        [liveId]: 'local',
        [staleId]: 'local',
        [worktreeWorkspaceKey(staleId)]: 'local'
      },
      structuredChatSleptAtByPaneKey: {
        [liveChatPane]: 1000,
        [staleChatPane]: 2000
      },
      everActivatedWorktreeIds: new Set<string>(),
      sleepingAgentSessionsByPaneKey: {},
      agentLaunchConfigByPaneKey: {},
      agentStatusByPaneKey,
      agentStatusEpoch: 0,
      acknowledgedAgentsByPaneKey: {},
      activityClearedAtByPaneKey: {},
      manuallyUnreadTurnsByPaneKey: {},
      unreadTerminalTabs: {},
      unreadTerminalPanes: {},
      unreadAgentCompletionPanes: {},
      paneForegroundAgentByPaneKey: {},
      lastTerminalInputAtByPaneKey: {},
      worktreeLineageById: {},
      workspaceLineageByChildKey: {},
      deleteStateByWorktreeId: {},
      baseStatusByWorktreeId: {},
      remoteBranchConflictByWorktreeId: {},
      fileSearchStateByWorktree: {},
      recentlyClosedBrowserTabsByWorktree: {},
      pendingReconnectTabByWorktree: {},
      rightSidebarTabByWorktree: {},
      rightSidebarExplorerViewByWorktree: {},
      gitStatusByWorktree: {},
      remoteStatusesByWorktree: {},
      gitStatusHeadByWorktree: {},
      gitBranchLineTotalByWorktree: {},
      gitIgnoredPathsByWorktree: {},
      gitConflictOperationByWorktree: {},
      trackedConflictPathsByWorktree: {},
      gitBranchChangesByWorktree: {},
      gitBranchCompareSummaryByWorktree: {},
      gitBranchCompareRequestKeyByWorktree: {},
      gitBranchCompareRequestStatusHeadByWorktree: {},
      gitStatusHugeByWorktree: {},
      explorerDisplayRootByWorktree: {},
      showDotfilesByWorktree: {},
      expandedDirs: {},
      recentlyClosedTerminalTabsByWorktree: {},
      lastVisitedAtByWorktreeId: {},
      defaultTerminalTabsAppliedByWorktreeId: {},
      localOnlyScrollbackByTabId: {},
      runtimePaneTitlesByTabId: {},
      automaticAgentResumeClaimsByTabId: {},
      nativeChatLaunchPromptByTabId: {},
      nativeChatLaunchDraftByTabId: {},
      expandedPaneByTabId: {},
      canExpandPaneByTabId: {},
      lastKnownRelayPtyIdByTabId: {},
      pendingReconnectPtyIdByTabId: {},
      unverifiedPtyLossTabIds: {},
      deferredSshSessionIdsByTabId: {},
      pendingInitialCwdByTabId: {},
      pendingIssueCommandSplitByTabId: {},
      pendingStartupByTabId: {},
      codexRestartNoticeByPtyId: {},
      migrationUnsupportedByPtyId: {},
      suppressedPtyExitIds: {},
      pendingPaneAccountRestarts: {},
      editorDrafts: {},
      markdownViewMode: {},
      markdownRichModeSizeOverride: {},
      markdownFrontmatterVisible: {},
      editorCursorLine: {},
      editorViewMode: {},
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      activeWorkspaceKey: null,
      activeTabId: null,
      activeFileId: null,
      activeBrowserTabId: null,
      activeTabType: 'terminal'
    } as unknown as AppState

    const patch = buildFullWorktreePurgeState(state, [{ id: staleId }])

    expect(patch.unifiedTabsByWorktree).toEqual({
      [liveId]: state.unifiedTabsByWorktree[liveId]
    })
    expect(patch.activeTabTypeByWorktree).toEqual({ [liveId]: 'terminal' })
    expect(patch.contestedPrimaryHostBySessionKey).toEqual({ [liveId]: 'local' })
    expect(patch.structuredChatSleptAtByPaneKey).toEqual({ [liveChatPane]: 1000 })
    expect(removedStatusEntries).toEqual([[staleChatPane, null]])
  })
})
