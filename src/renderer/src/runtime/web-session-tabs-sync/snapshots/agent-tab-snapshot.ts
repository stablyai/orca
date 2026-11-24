import type { RuntimeMobileSessionAgentTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import type { WebSessionTabsSyncState } from '../state'
import {
  canAdoptInitialHostGroups,
  directlyOpenedChatPublications,
  retainDirectlyOpenedChats
} from '../tracking/directly-opened-chat-tabs'

export function prepareAgentTabSnapshot(args: {
  state: WebSessionTabsSyncState
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  executionHostId: ExecutionHostId
  currentTabs: readonly Tab[]
  hostGroupIdByTabId: Map<string, string>
}) {
  const { state, snapshot, environmentId, executionHostId, currentTabs, hostGroupIdByTabId } = args
  const receivedChats = directlyOpenedChatPublications(environmentId, snapshot.worktree)
  const occupiedIds = receivedChats ? new Set<string>() : undefined
  const currentDirectTabs: Tab[] = []
  if (receivedChats && occupiedIds) {
    const directTabIds = new Set(Array.from(receivedChats.values(), (chat) => chat.tabId))
    for (const tab of currentTabs) {
      const id = tab.id
      occupiedIds.add(id)
      if (directTabIds.has(id)) {
        currentDirectTabs.push(tab)
      }
    }
  }
  const directlyOpened = retainDirectlyOpenedChats(
    environmentId,
    snapshot,
    currentDirectTabs,
    hostGroupIdByTabId
  )
  // A frame that still needs the linked chat's proof cannot own its initial placement.
  const adoptsInitialHostGroups = Boolean(
    !directlyOpened &&
    snapshot.tabGroups?.length &&
    canAdoptInitialHostGroups(state, snapshot.worktree, executionHostId, receivedChats)
  )
  const mayProject = directlyOpened
    ? (tab: RuntimeMobileSessionAgentTab): boolean =>
        !directlyOpened.has(tab.sessionId) &&
        (!tab.replacesSessionId || !directlyOpened.has(tab.replacesSessionId))
    : undefined
  const publishedAgentSessionIds = new Set(directlyOpened?.keys())
  // A chat this frame publishes or replaces is its to rebuild.
  const claimedAgentSessionIds = new Set(publishedAgentSessionIds)
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'agent-session' || (mayProject && !mayProject(tab))) {
      continue
    }
    publishedAgentSessionIds.add(tab.sessionId)
    claimedAgentSessionIds.add(tab.sessionId)
    if (tab.replacesSessionId) {
      claimedAgentSessionIds.add(tab.replacesSessionId)
    }
  }
  const mayAdopt = receivedChats
    ? (tab: Tab): boolean => {
        const proof = receivedChats.get(tab.entityId)
        return !proof || (tab.id === proof.tabId && tab.executionHostId === executionHostId)
      }
    : undefined
  return {
    adoptsInitialHostGroups,
    directlyOpened,
    publishedAgentSessionIds,
    claimedAgentSessionIds,
    projection: { occupiedIds, mayAdopt, mayProject }
  }
}
