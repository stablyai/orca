import type { Tab, TabGroup } from '../../../../shared/types'

export type TerminalOverlayAssignment = {
  groupId: string
  isActiveInGroup: boolean
}

export function buildTerminalOverlayAssignments(
  groups: readonly TabGroup[],
  unifiedTabs: readonly Tab[]
): Map<string, TerminalOverlayAssignment> {
  const activeTabByGroupId = new Map(groups.map((group) => [group.id, group.activeTabId]))
  const assignments = new Map<string, TerminalOverlayAssignment>()
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'terminal') {
      assignments.set(tab.entityId, {
        groupId: tab.groupId,
        isActiveInGroup: activeTabByGroupId.get(tab.groupId) === tab.id
      })
    }
  }
  return assignments
}
