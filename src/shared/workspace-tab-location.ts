import type { Tab, TabGroup, TabGroupLayoutNode } from './tab-types'
import { sha256 } from './sha256'

export type WorkspaceTabTopology = {
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode | null
  activeGroupId: string | null
}

export type TabGroupBounds = { x: number; y: number; width: number; height: number }

export function collectTabGroupBounds(
  layout: TabGroupLayoutNode | null,
  bounds: TabGroupBounds = { x: 0, y: 0, width: 1, height: 1 },
  result = new Map<string, TabGroupBounds>()
): Map<string, TabGroupBounds> {
  if (!layout) {
    return result
  }
  if (layout.type === 'leaf') {
    result.set(layout.groupId, bounds)
    return result
  }
  const ratio = layout.ratio ?? 0.5
  const horizontal = layout.direction === 'horizontal'
  collectTabGroupBounds(
    layout.first,
    {
      ...bounds,
      width: horizontal ? bounds.width * ratio : bounds.width,
      height: horizontal ? bounds.height : bounds.height * ratio
    },
    result
  )
  collectTabGroupBounds(
    layout.second,
    {
      x: horizontal ? bounds.x + bounds.width * ratio : bounds.x,
      y: horizontal ? bounds.y : bounds.y + bounds.height * ratio,
      width: horizontal ? bounds.width * (1 - ratio) : bounds.width,
      height: horizontal ? bounds.height : bounds.height * (1 - ratio)
    },
    result
  )
  return result
}

export function workspaceTabLayoutRevision(topology: WorkspaceTabTopology): string {
  const payload = JSON.stringify({
    tabs: topology.tabs.map((tab) => [tab.id, tab.entityId, tab.groupId, tab.isPinned ?? false]),
    groups: topology.groups.map((group) => [group.id, group.tabOrder, group.activeTabId]),
    layout: topology.layout,
    activeGroupId: topology.activeGroupId
  })
  return Array.from(sha256(new TextEncoder().encode(payload)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export function describeWorkspaceTabLayout(
  workspaceId: string,
  topology: WorkspaceTabTopology,
  availability: 'open' | 'saved',
  isWorkspaceActive = false
) {
  const bounds = collectTabGroupBounds(topology.layout)
  const groups = new Map(topology.groups.map((group) => [group.id, group]))
  return {
    schemaVersion: 1 as const,
    application: 'Orca' as const,
    workspaceId,
    availability,
    isWorkspaceActive,
    revision: workspaceTabLayoutRevision(topology),
    activeGroupId: topology.activeGroupId,
    groups: topology.groups.map((group) => ({
      groupId: group.id,
      tabOrder: group.tabOrder,
      activeTabId: group.activeTabId,
      bounds: bounds.get(group.id) ?? null
    })),
    layout: topology.layout,
    tabs: topology.tabs.map((tab) => {
      const group = groups.get(tab.groupId)
      const position = group?.tabOrder.indexOf(tab.id) ?? -1
      return {
        tabId: tab.id,
        contentId: tab.entityId,
        title: tab.customLabel ?? tab.generatedLabel ?? tab.label,
        type: tab.contentType,
        executionHostId: tab.executionHostId ?? null,
        groupId: tab.groupId,
        position: position < 0 ? null : position,
        isPinned: tab.isPinned ?? false,
        isDisplayed:
          availability === 'open' &&
          isWorkspaceActive &&
          bounds.has(tab.groupId) &&
          group?.activeTabId === tab.id,
        bounds: bounds.get(tab.groupId) ?? null
      }
    })
  }
}

export type WorkspaceTabLayoutDescription = ReturnType<typeof describeWorkspaceTabLayout>

export type WorkspaceTabLayoutAction =
  | { kind: 'move'; tabId: string; groupId: string; index: number }
  | { kind: 'split'; tabId: string; groupId: string; direction: 'left' | 'right' | 'up' | 'down' }
  | { kind: 'grid-2x2'; tabIds: string[] }

export type WorkspaceTabLayoutRequest = {
  requestId: string
  workspaceId: string
  expiresAt: number
  expectedRevision?: string
  action?: WorkspaceTabLayoutAction
}

export type WorkspaceTabLayoutResponse = {
  requestId: string
  layout?: WorkspaceTabLayoutDescription
  error?: string
}
