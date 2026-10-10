import { getRepoMapFromState, getWorktreeMapFromState } from '@/store/selectors'
import type { AppState } from '@/store/types'
import {
  getSettingsFocusedExecutionHostId,
  getWorktreeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { blocksFolderWorkspaceActivation } from '../../../../shared/folder-workspace-path-status'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { layoutContainsLeafId } from '../../../../shared/workspace-layout/terminal-pane-tree'
import { buildActivityEvents } from './activity-event-builder'
import {
  buildActivityTabHostIndex,
  resolveActivityExecutionHostId,
  type ActivityTabHostIndex
} from './activity-event-builder-context'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { collectChildAgentPaneKeys } from './activity-thread-child-agent'
import { hasActivityThreadWorkspace } from './activity-thread-actions'
import type { AgentPaneThread } from './activity-thread-types'

export type LatestAttentionSource = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'sleepingAgentSessionsByPaneKey'
  | 'repos'
  | 'worktreesByRepo'
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'getKnownWorktreeById'
  | 'getFreshFolderWorkspacePathStatus'
  | 'acknowledgedAgentsByPaneKey'
  | 'agentsShowChildAgents'
  | 'settings'
>

function canReachThread(
  thread: AgentPaneThread,
  source: LatestAttentionSource,
  hostIndex: ActivityTabHostIndex
): boolean {
  if (thread.worktree.isArchived) {
    return false
  }
  const parsed = parsePaneKey(thread.paneKey)
  if (!parsed || parsed.tabId !== thread.tab.id) {
    return false
  }
  const entry = thread.currentAgentEntry
  if (!entry) {
    return false
  }
  const requestedHost = resolveActivityExecutionHostId(
    { worktreeId: thread.worktree.id, tab: thread.tab },
    entry,
    thread.tab.ptyId,
    hostIndex
  )
  // The feed can fall back to a display row; navigation must retain the request's host.
  if (requestedHost && !source.getKnownWorktreeById(thread.worktree.id, requestedHost)) {
    return false
  }
  const scope = parseWorkspaceKey(thread.worktree.id)
  if (scope?.type === 'folder') {
    const host = parseExecutionHostId(
      getWorktreeExecutionHostId(
        thread.worktree,
        thread.repo ?? undefined,
        getSettingsFocusedExecutionHostId(source.settings)
      )
    )
    const pathStatus = source.getFreshFolderWorkspacePathStatus(
      { scope: 'folder-workspace', folderWorkspaceId: scope.folderWorkspaceId },
      { runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null }
    )
    if (blocksFolderWorkspaceActivation(pathStatus)) {
      return false
    }
  }
  const structured = source.unifiedTabsByWorktree[thread.worktree.id]?.some(
    (tab) => tab.id === thread.tab.id && tab.contentType === 'agent-session'
  )
  if (structured) {
    return hasActivityThreadWorkspace(thread, {
      ...source,
      defaultHostId: getSettingsFocusedExecutionHostId(source.settings)
    })
  }
  const layout = source.terminalLayoutsByTabId[thread.tab.id]?.root
  // A missing snapshot is unknown (cold remote tab); a present tree proves a removed pane.
  if (layout && !layoutContainsLeafId(layout, parsed.leafId)) {
    return false
  }
  if (thread.worktree.id === FLOATING_TERMINAL_WORKTREE_ID) {
    return (
      source.tabsByWorktree[thread.worktree.id]?.some((tab) => tab.id === thread.tab.id) ?? false
    )
  }
  const workspaceTabs = source.tabsByWorktree[thread.worktree.id]
  const sleeping = source.sleepingAgentSessionsByPaneKey[thread.paneKey]
  if (workspaceTabs && !workspaceTabs.some((tab) => tab.id === thread.tab.id) && !sleeping) {
    return false
  }
  return hasActivityThreadWorkspace(thread, {
    ...source,
    defaultHostId: getSettingsFocusedExecutionHostId(source.settings)
  })
}

/** Select the newest outstanding request, independent of whether it has already been read. */
export function resolveLatestAttentionThread(
  source: LatestAttentionSource,
  now = Date.now()
): AgentPaneThread | null {
  const activity = buildActivityEvents({
    agentStatusByPaneKey: source.agentStatusByPaneKey,
    runtimeAgentOrchestrationByPaneKey: source.runtimeAgentOrchestrationByPaneKey,
    // History and migration warnings cannot establish a currently pending request.
    retainedAgentsByPaneKey: {},
    tabsByWorktree: source.tabsByWorktree,
    unifiedTabsByWorktree: source.unifiedTabsByWorktree,
    worktreeMap: getWorktreeMapFromState(source),
    repoMap: getRepoMapFromState(source),
    repos: source.repos,
    resolveWorktree: source.getKnownWorktreeById,
    acknowledgedAgentsByPaneKey: source.acknowledgedAgentsByPaneKey,
    now
  })
  const threads = buildAgentPaneThreads(activity)
  const hostIndex = buildActivityTabHostIndex(source.unifiedTabsByWorktree)
  const childPaneKeys = source.agentsShowChildAgents
    ? new Set<string>()
    : collectChildAgentPaneKeys(threads)
  let latest: AgentPaneThread | null = null
  for (const thread of threads) {
    const entry = thread.currentAgentEntry
    if (
      !entry ||
      (thread.currentAgentState !== 'waiting' && thread.currentAgentState !== 'blocked') ||
      !Number.isFinite(entry.stateStartedAt) ||
      childPaneKeys.has(thread.paneKey) ||
      !canReachThread(thread, source, hostIndex)
    ) {
      continue
    }
    // Heartbeats update updatedAt; only a new request should change which agent wins.
    if (
      !latest ||
      entry.stateStartedAt > (latest.currentAgentEntry?.stateStartedAt ?? 0) ||
      (entry.stateStartedAt === latest.currentAgentEntry?.stateStartedAt &&
        thread.paneKey < latest.paneKey)
    ) {
      latest = thread
    }
  }
  return latest
}
