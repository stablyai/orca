import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { editorPlacementIndex } from '@/store/slices/editor/tabs/workspace-editor-files'
import { getOpenFileExecutionHostId } from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import { structuredLaunchSlotIds } from '../../agent-session/launch/structured-agent-session-launch-persistence'
import { launchSlotsForUnifiedBuild } from './workspace-session-launch-slots'
import type {
  Tab,
  TabGroup,
  TabGroupLayoutNode
} from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'

export type PersistedUnifiedTabSessionData = Pick<
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

type WorktreeTabSession = {
  tabs: Tab[]
  groups: TabGroup[]
  layout: TabGroupLayoutNode
  activeGroupId: string
}

type CachedWorktreeTabSession = {
  worktreeId: string
  groups: TabGroup[] | undefined
  layout: TabGroupLayoutNode | undefined
  activeGroupId: string | undefined
  slots: string
  session: WorktreeTabSession | null
}

/** Saved tab sessions keyed by each worktree's live tab array: a save reuses a worktree's previous
 *  output while its tabs, groups, layout, active group and launch slots are the same objects, so one
 *  tab switch rebuilds one worktree instead of the fleet. */
export type UnifiedTabSessionCache = {
  sessions: WeakMap<Tab[], CachedWorktreeTabSession>
  /** From the last whole build: workspaces that received another's editor tabs, and the launch
   *  slots it read. A build of some workspaces alone is only valid while both still hold. */
  placementTargets: ReadonlySet<string> | null
  slots: ReadonlyMap<string, string> | null
  /** Launch slots read during the save in progress (see launchSlotsForSave). */
  saveSlots: ReadonlyMap<string, string> | null
  /** The open files those placements were read from. */
  placementFiles: readonly OpenFile[] | undefined | null
}

export function createUnifiedTabSessionCache(): UnifiedTabSessionCache {
  return {
    sessions: new WeakMap(),
    placementTargets: null,
    slots: null,
    saveSlots: null,
    placementFiles: null
  }
}

function buildWorktreeTabSession(
  worktreeId: string,
  tabs: Tab[],
  sourceGroups: TabGroup[],
  layout: TabGroupLayoutNode | undefined,
  activeGroupId: string | undefined,
  hasSlots: boolean
): WorktreeTabSession | null {
  if (tabs.length === 0 && !hasSlots) {
    return null
  }
  const groups = buildPersistedGroupsForWorktree(tabs, sourceGroups, worktreeId)
  if (groups.length === 0) {
    return null
  }
  const groupIds = new Set(groups.map((group) => group.id))
  const keptTabs = tabs.filter((tab) => groupIds.has(tab.groupId))
  if (keptTabs.length === 0 && !hasSlots) {
    return null
  }
  const prunedLayout = layout ? prunePersistedLayoutForGroups(layout, groupIds) : null
  return {
    tabs: keptTabs,
    groups,
    layout: prunedLayout ?? { type: 'leaf', groupId: groups[0].id },
    activeGroupId: activeGroupId && groupIds.has(activeGroupId) ? activeGroupId : groups[0].id
  }
}

type UnifiedTabSnapshot = Pick<
  WorkspaceSessionSnapshot,
  'activeGroupIdByWorktree' | 'groupsByWorktree' | 'layoutByWorktree' | 'unifiedTabsByWorktree'
>

export function buildPersistedUnifiedTabSessionData(
  snapshot: UnifiedTabSnapshot & Partial<Pick<WorkspaceSessionSnapshot, 'openFiles'>>,
  cache?: UnifiedTabSessionCache
): PersistedUnifiedTabSessionData {
  const { sourceTabs, sourceGroups, movedTabs } = editorPlacementsInContentOwners(
    snapshot.openFiles,
    snapshot.unifiedTabsByWorktree,
    snapshot.groupsByWorktree
  )
  const data = buildUnifiedTabSessionData(snapshot, sourceTabs, sourceGroups, cache)
  if (cache) {
    cache.placementTargets = new Set(movedTabs.map((tab) => tab.worktreeId))
    cache.placementFiles = snapshot.openFiles
  }
  return data
}

function worktreeTabSessionFor(
  snapshot: UnifiedTabSnapshot,
  worktreeId: string,
  liveTabs: Tab[] | undefined,
  groups: TabGroup[] | undefined,
  slotsByWorktree: ReadonlyMap<string, string>,
  cache: UnifiedTabSessionCache | undefined
): WorktreeTabSession | null {
  const layout = snapshot.layoutByWorktree?.[worktreeId]
  const activeGroupId = snapshot.activeGroupIdByWorktree?.[worktreeId]
  const slots = slotsByWorktree.get(worktreeId) ?? ''
  const cached = liveTabs ? cache?.sessions.get(liveTabs) : undefined
  if (
    cached &&
    cached.worktreeId === worktreeId &&
    cached.groups === groups &&
    cached.layout === layout &&
    cached.activeGroupId === activeGroupId &&
    cached.slots === slots
  ) {
    return cached.session
  }
  const session = buildWorktreeTabSession(
    worktreeId,
    liveTabs ?? [],
    groups ?? [],
    layout,
    activeGroupId,
    slots !== ''
  )
  if (liveTabs) {
    cache?.sessions.set(liveTabs, { worktreeId, groups, layout, activeGroupId, slots, session })
  }
  return session
}

/** Live layout readback retains transient placement; only persistence transfers views to owners. */
export function buildUnifiedTabSessionData(
  snapshot: UnifiedTabSnapshot,
  sourceTabs = snapshot.unifiedTabsByWorktree,
  sourceGroups = snapshot.groupsByWorktree,
  cache?: UnifiedTabSessionCache,
  /** Build only these workspaces (a keyed save); the whole build covers every workspace. */
  onlyWorktreeIds?: ReadonlySet<string>
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const worktreeIds =
    onlyWorktreeIds ??
    new Set([
      ...Object.keys(sourceTabs),
      ...Object.keys(sourceGroups),
      ...Object.keys(snapshot.layoutByWorktree ?? {})
    ])

  const slotsByWorktree = launchSlotsForUnifiedBuild(cache)

  for (const worktreeId of worktreeIds) {
    const session = worktreeTabSessionFor(
      snapshot,
      worktreeId,
      sourceTabs[worktreeId],
      sourceGroups[worktreeId],
      slotsByWorktree,
      cache
    )
    if (!session) {
      continue
    }
    unifiedTabs[worktreeId] = session.tabs
    tabGroups[worktreeId] = session.groups
    activeGroupIdByWorktree[worktreeId] = session.activeGroupId
    tabGroupLayouts[worktreeId] = session.layout
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
  // Only a scoped rebuild reuses a moved tab's group id, so only it pays to index the fleet's groups.
  const usedGroupIds = sourceWorkspaceIds
    ? new Set(
        Object.entries(groupsByWorkspace).flatMap(([id, groups]) =>
          sourceWorkspaceIds.has(id) ? [] : groups.map((group) => group.id)
        )
      )
    : null
  for (const [workspaceId, tabs] of Object.entries(sourceTabs)) {
    if (sourceWorkspaceIds && !sourceWorkspaceIds.has(workspaceId)) {
      continue
    }
    const kept = tabs.filter((tab) => {
      const file = isEditorTabContentType(tab.contentType) ? files.get(tab.entityId) : undefined
      return !file || file.worktreeId === workspaceId
    })
    // Keep the live array when nothing moved so saves can tell the workspace is unchanged.
    sourceTabs[workspaceId] = kept.length === tabs.length ? tabs : kept
  }
  // Indexed on the first foreign edit tab; a save with none skips the fleet-wide walk.
  let existingPlacements: ReturnType<typeof editorPlacementIndex> | null = null
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
      existingPlacements ??= editorPlacementIndex(sourceTabs)
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
        (usedGroupIds && !usedGroupIds.has(tab.groupId) ? tab.groupId : `restored-editor:${owner}`)
      usedGroupIds?.add(groupId)
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
