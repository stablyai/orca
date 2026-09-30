import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'

/** Narrow a host inventory snapshot to the structured agent-session tabs it publishes. */
export function projectLocalStructuredSessionTabs(
  snapshot: RuntimeMobileSessionTabsResult
): RuntimeMobileSessionTabsResult {
  const structuredIds = new Set(
    snapshot.tabs.filter((tab) => tab.type === 'agent-session').map((tab) => tab.id)
  )
  const visibleHostTabIds = structuredIds
  const visibleIds = structuredIds
  const projectedTabGroups = snapshot.tabGroups
    ?.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((id) => visibleHostTabIds.has(id)),
      activeTabId:
        group.activeTabId && visibleHostTabIds.has(group.activeTabId) ? group.activeTabId : null,
      recentTabIds: group.recentTabIds?.filter((id) => visibleHostTabIds.has(id))
    }))
    .filter((group) => group.tabOrder.length > 0)

  return {
    ...snapshot,
    activeTabId: visibleIds.has(snapshot.activeTabId ?? '') ? snapshot.activeTabId : null,
    activeTabType:
      snapshot.activeTabId && visibleIds.has(snapshot.activeTabId) ? snapshot.activeTabType : null,
    activeGroupId:
      snapshot.activeGroupId &&
      projectedTabGroups?.some((group) => group.id === snapshot.activeGroupId)
        ? snapshot.activeGroupId
        : (projectedTabGroups?.[0]?.id ?? null),
    tabs: snapshot.tabs.filter((tab) => visibleIds.has(tab.id)),
    tabGroups: projectedTabGroups,
    // Why: group membership locates chats; the renderer's split tree remains locally authoritative.
    tabGroupLayout: undefined
  }
}
