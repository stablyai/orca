/** Publish under host-reserved IDs before the agent exists so PTY routing names this pane and retries reuse its tab; the pane’s spawn waits in main and attaches to the host’s process. */

import type { AgentLaunchPlacementReceipt } from '../../../shared/agent-launch-intent'
import type {
  AgentLaunchTabPublished,
  AgentLaunchTabPublishRequest
} from '../../../shared/agent-launch-tab-publication'
import { folderWorkspaceToWorktree } from '../../../shared/folder-workspace-worktree'
import { presentAgentLaunchTab } from './agent-launch-tab-presentation'
import { useAppStore } from '../store'
import { resolveUnifiedTabCreatePlacement } from '../store/slices/tabs/tabs-create-placement'
import { insertUnifiedTabAfterAnchor } from './unified-tab-anchor-insertion'
import { rememberAgentLaunchPanePrompt } from './agent-launch-pane-prompt'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

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
    // Clear an earlier launch’s outcome only for a new launch; retries retain the same tab and verdict.
    const kept = store.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.agentLaunchPane
    if (kept?.leafId !== leafId || kept.operationId !== request.operationId) {
      // A previously refused pane is idle; restart its spawn to await and attach to this launch.
      store.setTabAgentLaunchPane(tabId, launchPaneFor(request), {
        remount: kept?.leafId === leafId && kept.outcome !== undefined
      })
    }
    return { tabId, created: false, placement: { groupId } }
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
        ...(selectFolderWorkspaces(store) ?? []).map(folderWorkspaceToWorktree)
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
  if (placement.anchorTabId) {
    const unifiedTabId = useAppStore
      .getState()
      .unifiedTabsByWorktree[worktreeId]?.find((item) => item.entityId === tab.id)?.id
    if (unifiedTabId) {
      insertUnifiedTabAfterAnchor(worktreeId, unifiedTabId, placement.anchorTabId)
    }
  }
  presentAgentLaunchTab(request.viewer, worktreeId, tab.id, leafId)
  const landed = landedGroupId(worktreeId, tab.id) ?? placement.groupId ?? ''
  const fallback = placementFallback(request, landed, placement.anchorTabId !== undefined)
  return {
    tabId: tab.id,
    created: true,
    placement: { groupId: landed, ...(fallback ? { fallback } : {}) }
  }
}
