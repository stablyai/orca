import type { AppState } from '@/store/types'
import {
  workspacePresentationFor,
  workspaceSourceGroup,
  workspaceSourceTab,
  workspaceSourceOccurrence,
  rawStates
} from '@/store/workspace-source-state'
import {
  structuredAgentSessionTargetForTab,
  structuredAgentSessionOwnerForTab
} from './structured-agent-session-owner'
import {
  resolveHostSessionGroupIdForWebSessionTab,
  resolveHostSessionTabIdForWebSessionTab
} from './web-session-tabs-sync/tracking-mappings'

/** A displayed occurrence has an independent literal address, transport and outer placement. */
export function workspaceCommandAddress(state: AppState, workspaceId: string, tabId: string) {
  const occurrence = workspaceSourceOccurrence(state, tabId, workspaceId)
  if (!occurrence) {
    return undefined
  }
  const { tab, source, presentation } = occurrence
  const placement = presentation?.tabs.find((placed) => placed.id === tab.id)
  return {
    tab,
    workspaceId: tab.worktreeId,
    sourceGroupId: tab.groupId,
    physicalHostId:
      source.executionHostId ?? source.hostId ?? structuredAgentSessionOwnerForTab(state, tab),
    target: structuredAgentSessionTargetForTab(state, tab),
    protocolTabId: tab.contentType === 'agent-session' ? `agent-session:${tab.entityId}` : tab.id,
    displayWorkspaceId: presentation?.displayWorkspaceId ?? workspaceId,
    presentationGroupId: placement?.groupId ?? tab.groupId
  }
}

/** Unknown host groups/anchors use the old method's supported omission; U retains the requested destination. */
export function workspaceProtocolPlacement(
  state: Partial<
    Pick<
      AppState,
      | 'workspacePresentations'
      | 'groupsByWorktree'
      | 'unifiedTabsByWorktree'
      | 'activeGroupIdByWorktree'
    >
  >,
  environmentId: string,
  workspaceId: string,
  groupId?: string,
  afterTabId?: string
) {
  if (!workspacePresentationFor(state, workspaceId)) {
    return { targetGroupId: groupId, afterTabId }
  }
  const sourceGroup = workspaceSourceGroup(state, workspaceId, groupId)
  const sourceTabs = (rawStates.get(state) ?? state).unifiedTabsByWorktree?.[workspaceId] ?? []
  const rawGroupTab = sourceTabs.find((tab) => tab.groupId === sourceGroup)
  const targetGroupId = rawGroupTab
    ? (resolveHostSessionGroupIdForWebSessionTab({
        environmentId,
        worktreeId: workspaceId,
        tabId: rawGroupTab.id
      }) ?? undefined)
    : undefined
  const anchor = afterTabId ? workspaceSourceTab(state, afterTabId, workspaceId) : undefined
  return {
    targetGroupId,
    afterTabId:
      anchor?.worktreeId === workspaceId
        ? (resolveHostSessionTabIdForWebSessionTab(state, {
            environmentId,
            worktreeId: workspaceId,
            tabId: anchor.id
          }) ?? undefined)
        : undefined
  }
}
