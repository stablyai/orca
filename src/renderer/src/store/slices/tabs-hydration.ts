import { structuredLaunchSlotIds } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { resolveTabGroupOwners } from '../../../../shared/workspace-layout/tab-group-owners'
import {
  adoptGrouplessTabs,
  appendOwnedTabIdsToGroups,
  layoutSpanningGroups
} from './tab-group-reference-repair'
import {
  dedupeEditorTabsWithinGroups,
  getPersistedEditFileIdsByWorktree,
  sanitizeRecentTabIds,
  selectHydratedActiveGroupId
} from './tab-group-state'
import { dedupeTabOrder } from '../../../../shared/workspace-layout/tab-order'
import { restoresSavedContentTab } from '../../../../shared/workspace-layout/saved-editor-tab-restore'

type HydratedTabState = {
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
}

/** Keep one leaf per surviving group; repeats draw duplicate tab strips in separate columns. */
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
      .filter((tab) => {
        if (tab.contentType === 'terminal') {
          // Why: old web-client sessions could persist host surface ids
          // containing "::"; those are invalid pane-key tab ids.
          return isValidTerminalTabId(tab.id) && isValidTerminalTabId(tab.entityId)
        }
        // The same rule main's layout load applies, so neither holds a tab the other drops.
        return restoresSavedContentTab(tab, persistedEditFileIds, () =>
          keepsTransientTab(worktreeId, tab.entityId)
        )
      })
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
    const validatedGroups = appendOwnedTabIdsToGroups(groups, tabOwners).map((g) => {
      const slots = structuredLaunchSlotIds(worktreeId, g.id)
      const tabIdAliases = tabIdAliasesByGroup?.get(g.id)
      const canonicalTabId = (tabId: string): string => tabIdAliases?.get(tabId) ?? tabId
      // Repair persisted duplicate tabOrder IDs before neighbor/count-dependent operations.
      const tabOrder = dedupeTabOrder(
        g.tabOrder
          .map(canonicalTabId)
          .filter((tid) => tabOwners.get(tid) === g.id || slots.has(tid))
      )
      const canonicalActiveTabId = g.activeTabId ? canonicalTabId(g.activeTabId) : null
      const activeTabId =
        canonicalActiveTabId && tabOwners.get(canonicalActiveTabId) === g.id
          ? canonicalActiveTabId
          : null
      // Sanitize stale MRU IDs and put active tab last so first close restores prior selection rather than a neighbor.
      const sanitizedRecent = sanitizeRecentTabIds(
        g.recentTabIds?.map(canonicalTabId),
        tabOrder.filter((id) => tabOwners.get(id) === g.id)
      )
      const recentTabIds =
        activeTabId && sanitizedRecent.at(-1) !== activeTabId
          ? [...sanitizedRecent.filter((id) => id !== activeTabId), activeTabId]
          : sanitizedRecent
      return {
        ...g,
        tabOrder,
        activeTabId,
        recentTabIds
      }
    })
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
