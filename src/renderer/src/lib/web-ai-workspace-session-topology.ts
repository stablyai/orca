import { WEB_AI_BROWSER_WORKSPACE_ID } from '../../../shared/constants'
import type {
  BrowserWorkspace,
  Tab,
  TabGroup,
  TabGroupLayoutNode,
  WorkspaceSessionState
} from '../../../shared/types'

export type LegacyWebAiAccountMigration = {
  targetWorkspaceId: string
  workspaces: BrowserWorkspace[]
}

export type MigratedWebAiTabTopology = {
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode | null
  activeBrowserWorkspaceId: string | null
  activeGroupId: string | null
}

function migratedGroupId(targetWorkspaceId: string, sourceGroupId: string): string {
  return `legacy-web-ai-group:${targetWorkspaceId.length}:${targetWorkspaceId}:${sourceGroupId.length}:${sourceGroupId}`
}

function mapLayout(
  node: TabGroupLayoutNode,
  groupIdBySourceId: ReadonlyMap<string, string>
): TabGroupLayoutNode | null {
  if (node.type === 'leaf') {
    const groupId = groupIdBySourceId.get(node.groupId)
    return groupId ? { type: 'leaf', groupId } : null
  }
  const first = mapLayout(node.first, groupIdBySourceId)
  const second = mapLayout(node.second, groupIdBySourceId)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function appendMissingGroupsToLayout(
  layout: TabGroupLayoutNode | null,
  groups: readonly TabGroup[]
): TabGroupLayoutNode | null {
  const included = new Set<string>()
  const visit = (node: TabGroupLayoutNode | null): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      included.add(node.groupId)
      return
    }
    visit(node.first)
    visit(node.second)
  }
  visit(layout)

  let next = layout
  for (const group of groups) {
    if (included.has(group.id)) {
      continue
    }
    const leaf: TabGroupLayoutNode = { type: 'leaf', groupId: group.id }
    next = next ? { type: 'split', direction: 'horizontal', first: next, second: leaf } : leaf
  }
  return next
}

export function migrateLegacyWebAiTabTopology(
  session: WorkspaceSessionState,
  migration: LegacyWebAiAccountMigration
): MigratedWebAiTabTopology {
  const sourceTabs = session.unifiedTabs?.[WEB_AI_BROWSER_WORKSPACE_ID] ?? []
  const sourceGroups = session.tabGroups?.[WEB_AI_BROWSER_WORKSPACE_ID] ?? []
  const workspaceIds = new Set(migration.workspaces.map((workspace) => workspace.id))
  const accountTabs = sourceTabs.filter(
    (tab) => tab.contentType === 'browser' && workspaceIds.has(tab.entityId)
  )
  const sourceGroupById = new Map(sourceGroups.map((group) => [group.id, group] as const))
  const accountSourceGroupIds = new Set(accountTabs.map((tab) => tab.groupId))
  const sourceGroupIds = [
    ...sourceGroups
      .map((group) => group.id)
      .filter((groupId) => accountSourceGroupIds.has(groupId)),
    ...accountTabs.map((tab) => tab.groupId)
  ].filter((groupId, index, values) => values.indexOf(groupId) === index)
  const groupIdBySourceId = new Map(
    sourceGroupIds.map(
      (sourceGroupId) =>
        [sourceGroupId, migratedGroupId(migration.targetWorkspaceId, sourceGroupId)] as const
    )
  )
  const tabs = accountTabs.map((tab) => ({
    ...tab,
    worktreeId: migration.targetWorkspaceId,
    groupId: groupIdBySourceId.get(tab.groupId)!
  }))
  const accountTabIds = new Set(tabs.map((tab) => tab.id))
  const groups = sourceGroupIds.flatMap((sourceGroupId) => {
    const sourceGroup = sourceGroupById.get(sourceGroupId)
    const groupTabs = accountTabs.filter((tab) => tab.groupId === sourceGroupId)
    if (groupTabs.length === 0) {
      return []
    }
    const orderedIds = (sourceGroup?.tabOrder ?? []).filter((tabId) => accountTabIds.has(tabId))
    const tabOrder = [
      ...orderedIds,
      ...groupTabs.map((tab) => tab.id).filter((tabId) => !orderedIds.includes(tabId))
    ]
    const recentTabIds = (sourceGroup?.recentTabIds ?? []).filter((tabId) =>
      tabOrder.includes(tabId)
    )
    const activeTabId =
      (sourceGroup?.activeTabId && tabOrder.includes(sourceGroup.activeTabId)
        ? sourceGroup.activeTabId
        : recentTabIds.at(-1)) ??
      tabOrder[0] ??
      null
    return [
      {
        id: groupIdBySourceId.get(sourceGroupId)!,
        worktreeId: migration.targetWorkspaceId,
        activeTabId,
        tabOrder,
        recentTabIds
      }
    ] satisfies TabGroup[]
  })

  const sourceLayout = session.tabGroupLayouts?.[WEB_AI_BROWSER_WORKSPACE_ID]
  const layout = appendMissingGroupsToLayout(
    sourceLayout ? mapLayout(sourceLayout, groupIdBySourceId) : null,
    groups
  )
  const legacyActiveWorkspaceId =
    session.activeBrowserTabIdByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID] ?? null
  const activeBrowserWorkspaceId = workspaceIds.has(legacyActiveWorkspaceId ?? '')
    ? legacyActiveWorkspaceId
    : (tabs.find((tab) => tab.id === session.activeTabId)?.entityId ??
      tabs.find((tab) =>
        groups.some((group) => group.id === tab.groupId && group.activeTabId === tab.id)
      )?.entityId ??
      migration.workspaces[0]?.id ??
      null)
  const activeUnifiedTab = tabs.find((tab) => tab.entityId === activeBrowserWorkspaceId)
  const preferredSourceGroupId = session.activeGroupIdByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID]
  const preferredGroupId = preferredSourceGroupId
    ? groupIdBySourceId.get(preferredSourceGroupId)
    : null
  const activeGroupId =
    (preferredGroupId && groups.some((group) => group.id === preferredGroupId)
      ? preferredGroupId
      : activeUnifiedTab?.groupId) ??
    groups[0]?.id ??
    null

  return { tabs, groups, layout, activeBrowserWorkspaceId, activeGroupId }
}
