import { structuredLaunchSlotIds } from './structured-agent-session-launch-persistence'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { WorkspaceSessionSnapshot } from './workspace-session'
import {
  canRestorePersistedTab,
  dedupeEditorTabsWithinGroups,
  selectHydratedActiveGroupId
} from '../store/slices/tab-group-state'
import {
  appendOwnedTabIdsToGroups,
  adoptGrouplessTabs,
  layoutSpanningGroups,
  restrictGroupToOwnedTabs
} from '../store/slices/tab-group-reference-repair'
import { resolveTabGroupOwners } from '../../../shared/workspace-layout/tab-group-owners'
import { pruneTabGroupLayoutForGroups } from '../store/slices/tabs-hydration'

type PersistedUnifiedTabSessionData = Pick<
  WorkspaceSessionState,
  'activeGroupIdByWorktree' | 'tabGroupLayouts' | 'tabGroups' | 'unifiedTabs'
>

/** Same validity, dedupe, and ownership steps as hydration, so the file holds what restore keeps. */
function buildPersistedTabsAndGroups(
  worktreeId: string,
  tabs: readonly Tab[],
  groups: readonly TabGroup[],
  persistedEditFileIds: ReadonlySet<string>
): { tabs: Tab[]; groups: TabGroup[] } {
  // Filter before deduplication so an unrestorable copy cannot hide a live editor.
  const deduped = dedupeEditorTabsWithinGroups(
    tabs
      .filter((tab) => canRestorePersistedTab(tab, persistedEditFileIds))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
  )
  const restorableTabs = deduped.tabs
  const tabOwners = resolveTabGroupOwners(restorableTabs, groups, deduped.tabIdAliasesByGroup)
  const persistedGroups = appendOwnedTabIdsToGroups(groups, tabOwners)
    .map((group) =>
      restrictGroupToOwnedTabs(
        group,
        tabOwners,
        deduped.tabIdAliasesByGroup.get(group.id),
        structuredLaunchSlotIds(worktreeId, group.id)
      )
    )
    .filter((group) => group.tabOrder.length > 0)
  const persistedTabs = restorableTabs.map((tab) => {
    const groupId = tabOwners.get(tab.id)
    return groupId === undefined || groupId === tab.groupId ? tab : { ...tab, groupId }
  })
  const tabsByWorktree = { [worktreeId]: persistedTabs }
  const groupsByWorktree = { [worktreeId]: persistedGroups }
  // A missing group is not evidence that the user closed its content.
  adoptGrouplessTabs(tabsByWorktree, groupsByWorktree, {}, {})
  const adopted = dedupeEditorTabsWithinGroups(tabsByWorktree[worktreeId])
  const adoptedOwners = resolveTabGroupOwners(
    adopted.tabs,
    groupsByWorktree[worktreeId],
    adopted.tabIdAliasesByGroup
  )
  const finalGroups = groupsByWorktree[worktreeId].map((group) =>
    restrictGroupToOwnedTabs(
      group,
      adoptedOwners,
      adopted.tabIdAliasesByGroup.get(group.id),
      structuredLaunchSlotIds(worktreeId, group.id)
    )
  )
  const retainedById = new Map(adopted.tabs.map((tab) => [tab.id, tab]))
  return {
    tabs: finalGroups.flatMap((group) =>
      group.tabOrder.flatMap((id) => {
        const tab = retainedById.get(id)
        return tab ? [tab] : []
      })
    ),
    groups: finalGroups
  }
}

export function buildPersistedUnifiedTabSessionData(
  snapshot: Pick<
    WorkspaceSessionSnapshot,
    | 'activeGroupIdByWorktree'
    | 'groupsByWorktree'
    | 'layoutByWorktree'
    | 'openFiles'
    | 'unifiedTabsByWorktree'
  >
): PersistedUnifiedTabSessionData {
  const unifiedTabs: WorkspaceSessionState['unifiedTabs'] = {}
  const tabGroups: WorkspaceSessionState['tabGroups'] = {}
  const tabGroupLayouts: WorkspaceSessionState['tabGroupLayouts'] = {}
  const activeGroupIdByWorktree: WorkspaceSessionState['activeGroupIdByWorktree'] = {}
  const sourceTabs = snapshot.unifiedTabsByWorktree ?? {}
  const sourceGroups = snapshot.groupsByWorktree ?? {}
  const sourceLayouts = snapshot.layoutByWorktree ?? {}
  const sourceActiveGroups = snapshot.activeGroupIdByWorktree ?? {}
  // Why edit-mode only: buildEditorSessionData persists only those, and hydration reads that list.
  const persistedEditFileIdsByWorktree = new Map<string, Set<string>>()
  for (const file of snapshot.openFiles) {
    if (file.mode === 'edit') {
      const ids = persistedEditFileIdsByWorktree.get(file.worktreeId) ?? new Set<string>()
      ids.add(file.filePath)
      persistedEditFileIdsByWorktree.set(file.worktreeId, ids)
    }
  }
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

    const persisted = buildPersistedTabsAndGroups(
      worktreeId,
      tabs,
      sourceGroups[worktreeId] ?? [],
      persistedEditFileIdsByWorktree.get(worktreeId) ?? new Set<string>()
    )
    if (persisted.groups.length === 0) {
      continue
    }

    unifiedTabs[worktreeId] = persisted.tabs
    tabGroups[worktreeId] = persisted.groups
    const groupIds = new Set(persisted.groups.map((group) => group.id))
    const activeGroupId = selectHydratedActiveGroupId(
      persisted.groups,
      sourceActiveGroups[worktreeId]
    )
    if (activeGroupId) {
      activeGroupIdByWorktree[worktreeId] = activeGroupId
    }
    const prunedLayout = sourceLayouts[worktreeId]
      ? pruneTabGroupLayoutForGroups(sourceLayouts[worktreeId], groupIds)
      : null
    // A partial layout must still render every surviving group, as hydration lays it out.
    tabGroupLayouts[worktreeId] = layoutSpanningGroups(persisted.groups, prunedLayout)
  }

  return {
    unifiedTabs,
    tabGroups,
    tabGroupLayouts,
    activeGroupIdByWorktree
  }
}
