import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../types'

export function sameTerminalParkingTab(
  previous: TerminalTab | undefined,
  next: TerminalTab
): boolean {
  return (
    previous !== undefined &&
    previous.id === next.id &&
    previous.worktreeId === next.worktreeId &&
    previous.ptyId === next.ptyId &&
    previous.pendingActivationSpawn === next.pendingActivationSpawn &&
    previous.generation === next.generation &&
    previous.startupCwd === next.startupCwd &&
    previous.launchAgent === next.launchAgent
  )
}

export function sameTerminalParkingTitleSlots(
  previous: AppState['runtimePaneTitlesByTabId'][string] | undefined,
  next: AppState['runtimePaneTitlesByTabId'][string] | undefined
): boolean {
  if (previous === next) {
    return true
  }
  const before = Object.keys(previous ?? {})
  const after = Object.keys(next ?? {})
  return before.length === after.length && before.every((key) => key in (next ?? {}))
}

export function sameTerminalParkingAssignments(
  previous: readonly Tab[],
  next: readonly Tab[],
  groups: readonly TabGroup[]
): boolean {
  const before = new Map<string, Tab>()
  const after = new Map<string, Tab>()
  for (const tab of previous) {
    if (tab.contentType === 'terminal') {
      before.set(tab.entityId, tab)
    }
  }
  for (const tab of next) {
    if (tab.contentType === 'terminal') {
      after.set(tab.entityId, tab)
    }
  }
  if (before.size !== after.size) {
    return false
  }
  const activeTabByGroupId = new Map(groups.map((group) => [group.id, group.activeTabId]))
  for (const [tabId, tab] of after) {
    const previousTab = before.get(tabId)
    if (
      !previousTab ||
      previousTab.groupId !== tab.groupId ||
      (activeTabByGroupId.get(previousTab.groupId) === previousTab.id) !==
        (activeTabByGroupId.get(tab.groupId) === tab.id)
    ) {
      return false
    }
  }
  return true
}
