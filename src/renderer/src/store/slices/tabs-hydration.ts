import { structuredLaunchSlotIds } from '@/lib/structured-agent-session-launch-persistence'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { resolveTabGroupOwners } from '../../../../shared/workspace-layout/tab-group-owners'
import {
  adoptGrouplessTabs,
  appendOwnedTabIdsToGroups,
  layoutSpanningGroups,
  restrictGroupToOwnedTabs
} from './tab-group-reference-repair'
import {
  dedupeEditorTabsWithinGroups,
  getPersistedEditFileIdsByWorktree,
  canRestorePersistedTab,
  selectHydratedActiveGroupId
} from './tab-group-state'

type HydratedTabState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

/** Drops leaves whose group is gone, and repeat leaves for a group already
 *  placed earlier in the tree — one column per group is the render invariant,
 *  and a repeated leaf paints the same tab strip in every one of its columns. */
export function pruneTabGroupLayoutForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>
): TabGroupLayoutNode | null {
  return pruneLayoutNodeForGroups(root, validGroupIds, new Set())
}

function pruneLayoutNodeForGroups(
  root: TabGroupLayoutNode,
  validGroupIds: Set<string>,
  placedGroupIds: Set<string>
): TabGroupLayoutNode | null {
  if (root.type === 'leaf') {
    if (!validGroupIds.has(root.groupId) || placedGroupIds.has(root.groupId)) {
      return null
    }
    placedGroupIds.add(root.groupId)
    return root
  }

  const first = pruneLayoutNodeForGroups(root.first, validGroupIds, placedGroupIds)
  const second = pruneLayoutNodeForGroups(root.second, validGroupIds, placedGroupIds)

  if (first === null) {
    return second
  }
  if (second === null) {
    return first
  }
  if (first === root.first && second === root.second) {
    return root
  }

  return { ...root, first, second }
}

/** Tabs come from the tab bar alone; terminal rows it lacks are adopted later by reconciliation. */
export function buildHydratedTabState(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>,
  /** A diff, conflict or check tab a frame build keeps: its frame carries the tab's view. */
  keepsTransientTab: (worktreeId: string, entityId: string) => boolean = () => false
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}
  const tabIdAliasesByWorktree: Record<string, Map<string, Map<string, string>>> = {}
  const persistedEditFileIdsByWorktree = getPersistedEditFileIdsByWorktree(session)

  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (tabs.length === 0) {
      continue
    }
    const persistedEditFileIds = persistedEditFileIdsByWorktree[worktreeId] ?? new Set<string>()
    const generatedTitleByTerminalId = new Map(
      (session.tabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.generatedTitle?.trim())
        .map((tab) => [tab.id, tab.generatedTitle!.trim()])
    )
    const quickCommandLabelByTerminalId = new Map(
      (session.tabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.quickCommandLabel?.trim())
        .map((tab) => [tab.id, tab.quickCommandLabel!.trim()])
    )
    const aiVaultTitleByTerminalId = new Map(
      (session.tabsByWorktree[worktreeId] ?? [])
        .filter((tab) => tab.aiVaultTitle)
        .map((tab) => [tab.id, tab.aiVaultTitle!])
    )
    const hydratedTabs = [...tabs]
      .map((tab) => ({
        ...tab,
        entityId: tab.entityId ?? tab.id
      }))
      .map((tab) => {
        if (tab.contentType !== 'terminal') {
          return tab
        }
        const quickCommandLabel = tab.quickCommandLabel?.trim()
          ? tab.quickCommandLabel.trim()
          : quickCommandLabelByTerminalId.get(tab.entityId)
        const generatedLabel = generatedTitleByTerminalId.get(tab.entityId)
        const aiVaultTitle = tab.aiVaultTitle ?? aiVaultTitleByTerminalId.get(tab.entityId)
        return {
          ...tab,
          ...(quickCommandLabel ? { quickCommandLabel } : {}),
          ...(aiVaultTitle ? { aiVaultTitle } : {}),
          ...(!tab.generatedLabel?.trim() && generatedLabel ? { generatedLabel } : {})
        }
      })
      .filter((tab) =>
        canRestorePersistedTab(tab, persistedEditFileIds, (entityId) =>
          keepsTransientTab(worktreeId, entityId)
        )
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    // Why after the sort: the surviving record is the one the strip renders first.
    const deduped = dedupeEditorTabsWithinGroups(hydratedTabs)
    tabsByWorktree[worktreeId] = deduped.tabs
    tabIdAliasesByWorktree[worktreeId] = deduped.tabIdAliasesByGroup
  }

  for (const [worktreeId, groups] of Object.entries(session.tabGroups ?? {})) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (groups.length === 0) {
      continue
    }

    const hydratedTabsForWorktree = tabsByWorktree[worktreeId] ?? []
    const tabIdAliasesByGroup = tabIdAliasesByWorktree[worktreeId]
    const tabOwners = resolveTabGroupOwners(hydratedTabsForWorktree, groups, tabIdAliasesByGroup)
    const validatedGroups = appendOwnedTabIdsToGroups(groups, tabOwners).map((group) =>
      restrictGroupToOwnedTabs(
        group,
        tabOwners,
        tabIdAliasesByGroup?.get(group.id),
        structuredLaunchSlotIds(worktreeId, group.id)
      )
    )
    const hydratedGroups = validatedGroups.filter((group, index) => {
      const hadTabsBeforeHydration = groups[index]?.tabOrder.length > 0
      if (group.tabOrder.length > 0) {
        return true
      }
      if (hadTabsBeforeHydration) {
        return false
      }
      return validatedGroups.every((candidate) => candidate.tabOrder.length === 0)
    })
    if (hydratedGroups.length === 0) {
      if ((tabsByWorktree[worktreeId] ?? []).length === 0) {
        delete tabsByWorktree[worktreeId]
      }
      continue
    }

    groupsByWorktree[worktreeId] = hydratedGroups
    const activeGroupId = selectHydratedActiveGroupId(
      hydratedGroups,
      session.activeGroupIdByWorktree?.[worktreeId]
    )
    if (activeGroupId) {
      activeGroupIdByWorktree[worktreeId] = activeGroupId
    }
    const hydratedGroupIds = new Set(hydratedGroups.map((group) => group.id))
    const hydratedLayout = session.tabGroupLayouts?.[worktreeId]
      ? pruneTabGroupLayoutForGroups(session.tabGroupLayouts[worktreeId], hydratedGroupIds)
      : null
    // A partial layout must still render every surviving group.
    layoutByWorktree[worktreeId] = layoutSpanningGroups(hydratedGroups, hydratedLayout)
  }

  adoptGrouplessTabs(tabsByWorktree, groupsByWorktree, activeGroupIdByWorktree, layoutByWorktree)

  return {
    unifiedTabsByWorktree: tabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree
  }
}
