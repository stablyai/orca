import type { AppState } from '../store/types'
import { findWorkspaceCreationTab } from '../../../shared/workspace-creation-tab'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'
import { findKnownWorktreeById } from '../store/slices/worktrees/listing/detected-worktree-meta'

export function preferredWorkspaceViewerTab(
  tabs: readonly Tab[],
  terminals: readonly TerminalTab[],
  createdWithAgent: TuiAgent | undefined
): Tab | null {
  if (tabs.some((tab) => Number.isFinite(tab.lastFocusedAt))) {
    return null
  }
  const terminalAgents = new Map(terminals.map((tab) => [tab.id, tab.launchAgent]))
  return (
    findWorkspaceCreationTab(tabs, createdWithAgent, (tab) =>
      tab.contentType === 'agent-session'
        ? tab.agentSessionAgent
        : tab.contentType === 'terminal'
          ? terminalAgents.get(tab.entityId)
          : undefined
    ) ?? null
  )
}

/**
 * Shows a viewer that has not chosen a tab the one the workspace was created for, through the
 * actions a tab click uses, and lets the visible surface follow it. Does nothing when there is no
 * such tab. Returns the creation tab it selected, if any.
 */
export function selectWorkspaceCreationTab(
  state: Pick<
    AppState,
    | 'unifiedTabsByWorktree'
    | 'tabsByWorktree'
    | 'groupsByWorktree'
    | 'activeGroupIdByWorktree'
    | 'activateTab'
    | 'focusGroup'
  >,
  worktreeId: string,
  createdWithAgent: TuiAgent | undefined
): string | null {
  const tab = preferredWorkspaceViewerTab(
    state.unifiedTabsByWorktree[worktreeId] ?? [],
    state.tabsByWorktree[worktreeId] ?? [],
    createdWithAgent
  )
  if (!tab) {
    return null
  }
  const groups = state.groupsByWorktree[worktreeId] ?? []
  // Why: reconciliation runs from effects; re-activating an already shown tab would loop them.
  if (
    state.activeGroupIdByWorktree[worktreeId] !== tab.groupId ||
    groups.find((group) => group.id === tab.groupId)?.activeTabId !== tab.id
  ) {
    // Derived display never creates new evidence of a viewer choice.
    state.activateTab(tab.id, { worktreeId, recordFocus: false })
  }
  if (groups.some((group) => group.id === tab.groupId)) {
    // A no-op when the visible surface already shows the group's tab.
    state.focusGroup(worktreeId, tab.groupId)
  }
  return tab.id
}

/** `selectWorkspaceCreationTab` with the workspace's `createdWithAgent` looked up on its owner. */
export function selectWorkspaceCreationTabForWorktree(
  state: AppState,
  worktreeId: string
): string | null {
  const createdWithAgent = findKnownWorktreeById(
    state,
    worktreeId,
    resolveWorktreeOperationRoute(state, worktreeId)?.executionHostId ?? undefined
  )?.createdWithAgent
  return selectWorkspaceCreationTab(state, worktreeId, createdWithAgent)
}
