import type { RuntimeMobileSessionAgentTab } from '../../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { hasStructuredAgentSessionLaunchCancellationTombstone } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
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
  const currentTabsById = receivedChats ? new Map<string, Tab>() : undefined
  const currentDirectTabs: Tab[] = []
  const directlyOpenedWithIncomingGroup = new Set<string>()
  if (receivedChats && currentTabsById) {
    for (const tab of currentTabs) {
      currentTabsById.set(tab.id, tab)
    }
    for (const { tabId, hostTabId } of receivedChats.values()) {
      const tab = currentTabsById.get(tabId)
      if (tab) {
        currentDirectTabs.push(tab)
      }
      if (hostGroupIdByTabId.has(hostTabId)) {
        directlyOpenedWithIncomingGroup.add(hostTabId)
      }
    }
  }
  const directlyOpened = retainDirectlyOpenedChats(
    environmentId,
    snapshot,
    currentDirectTabs,
    hostGroupIdByTabId
  )
  const mayAdoptInitialHostGroups = Boolean(
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
  let framePublishesDirectChat = false
  for (const tab of snapshot.tabs) {
    if (tab.type !== 'agent-session') {
      continue
    }
    if (mayProject && !mayProject(tab)) {
      framePublishesDirectChat ||= Boolean(
        directlyOpened?.get(tab.sessionId)?.hostTabId === tab.id &&
        !hasStructuredAgentSessionLaunchCancellationTombstone(snapshot.worktree, tab.sessionId)
      )
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
    mayAdoptInitialHostGroups,
    directlyOpened,
    directlyOpenedWithIncomingGroup,
    framePublishesDirectChat,
    publishedAgentSessionIds,
    claimedAgentSessionIds,
    projection: { currentTabsById, mayAdopt, mayProject }
  }
}
