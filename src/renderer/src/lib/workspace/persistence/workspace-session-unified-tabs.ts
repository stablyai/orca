import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorPlacementIndex } from '@/store/slices/editor/tabs/workspace-editor-files'
import { getOpenFileExecutionHostId } from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { structuredLaunchSlotIds } from '../../agent-session/launch/structured-agent-session-launch-persistence'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

function prunePersistedLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    return validGroupIds.has(root.groupId) ? root : null
  }

  const first = prunePersistedLayoutForGroups(root.first, validGroupIds)
  const second = prunePersistedLayoutForGroups(root.second, validGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }

  return { ...root, first, second }
}

function buildPersistedGroupsForWorktree(
  tabs: Tab[],
  groups: TabGroup[],
  worktreeId: string
): TabGroup[] {
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const tabIdsByGroup = new Map<string, string[]>()
  for (const tab of tabs) {
    const groupTabs = tabIdsByGroup.get(tab.groupId) ?? []
    groupTabs.push(tab.id)
    tabIdsByGroup.set(tab.groupId, groupTabs)
  }

  return groups
    .map((group) => {
      const slots = structuredLaunchSlotIds(worktreeId, group.id)
      const orderedTabIds = new Set([
        ...group.tabOrder.filter((tabId) => validTabIds.has(tabId) || slots.has(tabId)),
        ...(tabIdsByGroup.get(group.id) ?? [])
      ])
      const tabOrder = Array.from(orderedTabIds)
      const activeTabId =
        group.activeTabId && validTabIds.has(group.activeTabId) ? group.activeTabId : null
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: group.recentTabIds?.filter((tabId) => validTabIds.has(tabId))
      }
    })
    .filter((group) => group.tabOrder.length > 0)
}

type UnifiedTabSnapshot = Pick<
  WorkspaceSessionSnapshot,
  'activeGroupIdByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree'
>

export function buildPersistedUnifiedTabSessionData(
  snapshot: UnifiedTabSnapshot & Partial<Pick<WorkspaceSessionSnapshot, 'openFiles'>>
): PersistedUnifiedTabSessionData {
  const { sourceTabs, sourceGroups } = editorPlacementsInContentOwners(
    snapshot.openFiles,
    snapshot.unifiedTabsByWorktree,
    snapshot.groupsByWorktree
  )
  return buildUnifiedTabSessionData(snapshot, sourceTabs, sourceGroups)
}

/** Live layout readback retains transient placement; only persistence transfers views to owners. */
export function buildUnifiedTabSessionData(
  snapshot: UnifiedTabSnapshot,
  sourceTabs = snapshot.unifiedTabsByWorktree,
  sourceGroups = snapshot.groupsByWorktree
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  const worktreeIds = new Set([
    ...Object.keys(sourceTabs),
    ...Object.keys(sourceGroups),
    ...Object.keys(sourceLayouts)
  ])

  for (const worktreeId of worktreeIds) {
    const tabs = sourceTabs[worktreeId] ?? []
    if (tabs.length === 0 && structuredLaunchSlotIds(worktreeId).size === 0) {
      continue
    }

    const groups = buildPersistedGroupsForWorktree(tabs, sourceGroups[worktreeId] ?? [], worktreeId)
    if (groups.length === 0) {
      continue
    }

    const groupIds = new Set(groups.map((group) => group.id))
    const persistedTabs = tabs.filter((tab) => groupIds.has(tab.groupId))
    if (persistedTabs.length === 0 && structuredLaunchSlotIds(worktreeId).size === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persistedTabs
    tabGroups[worktreeId] = groups
    const activeGroupId = sourceActiveGroups[worktreeId]
    activeGroupIdByWorktree[worktreeId] =
      activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
    const prunedLayout = sourceLayouts[worktreeId]
      ? prunePersistedLayoutForGroups(sourceLayouts[worktreeId], groupIds)
      : null
    tabGroupLayouts[worktreeId] = prunedLayout ?? { type: 'leaf', groupId: groups[0].id }
  }

  return {
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree
  }
}

/** Cross-workspace placement is transient; writable files restore in their content workspace. */
export function editorPlacementsInContentOwners(
  openFiles: readonly OpenFile[] | undefined,
  tabsByWorkspace: Record<string, Tab[]>,
  groupsByWorkspace: Record<string, TabGroup[]>,
  sourceWorkspaceIds?: ReadonlySet<string>
) {
  const sourceTabs = { ...tabsByWorkspace }
  const sourceGroups = { ...groupsByWorkspace }
  const files = new Map(openFiles?.map((file) => [file.id, file]))
  const movedTabs: Tab[] = []
  const moved = new Set<string>()
  const targets = new Set<string>()
  const usedGroupIds = new Set(
    Object.entries(groupsByWorkspace).flatMap(([id, groups]) =>
      sourceWorkspaceIds?.has(id) ? [] : groups.map((group) => group.id)
    )
  )
  for (const [workspaceId, tabs] of Object.entries(sourceTabs)) {
    if (sourceWorkspaceIds && !sourceWorkspaceIds.has(workspaceId)) {
      continue
    }
    sourceTabs[workspaceId] = tabs.filter((tab) => {
      const file = isEditorTabContentType(tab.contentType) ? files.get(tab.entityId) : undefined
      return !file || file.worktreeId === workspaceId
    })
  }
  const existingPlacements = editorPlacementIndex(sourceTabs)
  for (const [workspaceId, tabs] of Object.entries(tabsByWorkspace)) {
    if (sourceWorkspaceIds && !sourceWorkspaceIds.has(workspaceId)) {
      continue
    }
    for (const tab of tabs) {
      const file = isEditorTabContentType(tab.contentType) ? files.get(tab.entityId) : undefined
      if (!file || file.worktreeId === workspaceId || file.mode !== 'edit' || moved.has(file.id)) {
        continue
      }
      const owner = file.worktreeId
      if (existingPlacements.workspacesByEntityId.get(file.id)?.has(owner)) {
        continue
      }
      moved.add(file.id)
      if (!targets.has(owner)) {
        sourceTabs[owner] = [...(sourceTabs[owner] ?? [])]
        sourceGroups[owner] = (sourceGroups[owner] ?? []).map((group) => ({
          ...group,
          tabOrder: [...group.tabOrder]
        }))
        targets.add(owner)
      }
      const groupId =
        sourceGroups[owner]?.[0]?.id ??
        (sourceWorkspaceIds && !usedGroupIds.has(tab.groupId)
          ? tab.groupId
          : `restored-editor:${owner}`)
      usedGroupIds.add(groupId)
      const movedTab = {
        ...tab,
        worktreeId: owner,
        groupId,
        executionHostId: getOpenFileExecutionHostId(file)
      }
      movedTabs.push(movedTab)
      sourceTabs[owner]!.push(movedTab)
      if (!sourceGroups[owner]?.length) {
        sourceGroups[owner] = [
          { id: groupId, worktreeId: owner, tabOrder: [tab.id], activeTabId: tab.id }
        ]
      } else {
        const group = sourceGroups[owner]![0]!
        group.tabOrder.push(tab.id)
      }
    }
  }
  return { sourceTabs, sourceGroups, movedTabs }
}
