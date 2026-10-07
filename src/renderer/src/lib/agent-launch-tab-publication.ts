/**
 * Showing an `agent.launch` tab the host asked for before its agent exists.
 *
 * The tab is created under the host's ids so the pane key the host bakes into the agent's PTY names
 * this pane, and a retry that names the same tab finds it instead of making a second one. The pane
 * is laid out with no process; its own spawn waits in main for the host's and attaches to it.
 */

import type { AgentLaunchPlacementReceipt } from '../../../shared/agent-launch-intent'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import {
  activateTerminalInitiatedWorktree,
  focusTerminalInitiatedTab
} from '../hooks/ipc-events/terminal-command-state'
import { useAppStore } from '../store'
import { resolveUnifiedTabCreatePlacement } from '../store/slices/tabs/tabs-create-placement'
import { insertUnifiedTabAfterAnchor } from './unified-tab-anchor-insertion'
import { rememberAgentLaunchPanePrompt } from './agent-launch-pane-prompt'
import { releaseAgentLaunchPaneSpawn } from './agent-launch-pane-spawn-hold'

function landedGroupId(worktreeId: string, tabId: string): string | undefined {
  return useAppStore
    .getState()
    .unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.entityId === tabId)?.groupId
}

function placementFallback(
  request: AgentLaunchTabPublishRequest,
  landed: string,
  anchored: boolean
): AgentLaunchPlacementReceipt['fallback'] {
  const { groupId, afterTabId } = request.placement ?? {}
  if (groupId !== undefined) {
    return landed === groupId ? undefined : anchored ? 'anchor-group' : 'active-group'
  }
  return afterTabId !== undefined && !anchored ? 'active-group' : undefined
}

function launchPaneFor(request: AgentLaunchTabPublishRequest): {
  leafId: string
  operationId?: string
} {
  return {
    leafId: request.leafId,
    ...(request.operationId ? { operationId: request.operationId } : {})
  }
}

export function publishAgentLaunchTab(
  request: AgentLaunchTabPublishRequest
): AgentLaunchTabPublished {
  const { worktreeId, tabId, leafId } = request
  const store = useAppStore.getState()
  const owner = Object.entries(store.tabsByWorktree).find(([, tabs]) =>
    tabs.some((tab) => tab.id === tabId)
  )?.[0]
  if (owner !== undefined) {
    // A retry naming the same tab: never a second one, and never another workspace's tab.
    if (owner !== worktreeId) {
      throw new Error('agent_launch_tab_id_taken')
    }
    const groupId = landedGroupId(worktreeId, tabId)
    if (!groupId) {
      throw new Error('agent_launch_tab_unplaced')
    }
    if (request.prompt) {
      rememberAgentLaunchPanePrompt(tabId, request.prompt)
    }
    // A different launch into this pane: what an earlier one left on it no longer stands. A retry of
    // the same launch is that launch, so its tab and any final verdict stay as they are.
    const kept = store.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.agentLaunchPane
    if (kept?.leafId !== leafId || kept.operationId !== request.operationId) {
      // A pane that already showed an earlier launch's outcome refused its spawn and is idle: it
      // must spawn again, so it waits for this launch and attaches to its agent.
      store.setTabAgentLaunchPane(tabId, launchPaneFor(request), {
        remount: kept?.leafId === leafId && kept.outcome !== undefined
      })
    }
    // A tab this window made for this launch is the launch's to take back if it never runs.
    const madeForThisLaunch = releaseAgentLaunchPaneSpawn(tabId, leafId)
    return { tabId, created: madeForThisLaunch, placement: { groupId } }
  }

  const placement = resolveUnifiedTabCreatePlacement({
    groups: store.groupsByWorktree[worktreeId] ?? [],
    tabs: store.unifiedTabsByWorktree[worktreeId] ?? [],
    activeGroupId: store.activeGroupIdByWorktree[worktreeId],
    targetGroupId: request.placement?.groupId,
    afterTabId: request.placement?.afterTabId,
    lookupWorktrees: () =>
      [
        ...(store.allWorktrees?.() ?? []),
        ...(store.folderWorkspaces ?? []).map(folderWorkspaceToWorktree)
      ].filter((worktree) => worktree.id === worktreeId)
  })
  const focuses = request.viewer === 'focus-window' || request.viewer === 'focus-in-workspace'
  const tab = store.createTab(worktreeId, placement.groupId, undefined, {
    id: tabId,
    initialLeafId: leafId,
    agentLaunchPane: launchPaneFor(request),
    launchAgent: request.launchAgent,
    viewMode: request.viewMode,
    ...(focuses ? {} : { activate: false, recordInteraction: false })
  })
  if (request.prompt) {
    rememberAgentLaunchPanePrompt(tabId, request.prompt)
  }
  if (tab.id !== tabId) {
    // createTab mints a fresh id on a collision it saw and we did not; that tab would never attach.
    useAppStore.getState().closeTab(tab.id, { recordInteraction: false })
    throw new Error('agent_launch_tab_id_taken')
  }
  if (placement.anchorTabId) {
    const unifiedTabId = useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((item) => item.entityId === tab.id)?.id
    if (unifiedTabId) {
      insertUnifiedTabAfterAnchor(worktreeId, unifiedTabId, placement.anchorTabId)
    }
  }
  if (request.viewer === 'focus-window') {
    // After the tab lands: activating prunes the workspace's empty groups, the requested split too.
    activateTerminalInitiatedWorktree(useAppStore.getState(), worktreeId, [tab.id])
  }
  const current = useAppStore.getState()
  // The desktop's own launch stays in its workspace: the window follows only if it is still there.
  const windowShowsTab =
    request.viewer === 'focus-window' ||
    (request.viewer === 'focus-in-workspace' && current.activeWorktreeId === worktreeId)
  if (windowShowsTab) {
    current.setActiveTabType('terminal', worktreeId)
    current.setActiveTab(tab.id)
  }
  if (windowShowsTab || request.viewer === 'reveal-owner') {
    if (request.viewer !== 'focus-in-workspace') {
      current.revealWorktreeInSidebar(worktreeId)
    }
    focusTerminalInitiatedTab(tab.id, leafId, worktreeId)
  }
  const landed = landedGroupId(worktreeId, tab.id) ?? placement.groupId ?? ''
  const fallback = placementFallback(request, landed, placement.anchorTabId !== undefined)
  return {
    tabId: tab.id,
    created: true,
    placement: { groupId: landed, ...(fallback ? { fallback } : {}) }
  }
}
