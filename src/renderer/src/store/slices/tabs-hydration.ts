import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { adoptGrouplessTabs, layoutSpanningGroups } from './tab-group-reference-repair'
import {
  dedupeTabOrder,
  dedupeTabsById,
  getPersistedEditFileIdsByWorktree,
  isTransientEditorContentType,
  sanitizeRecentTabIds,
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

function hydrateUnifiedFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}
  const persistedEditFileIdsByWorktree = getPersistedEditFileIdsByWorktree(session)

  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs!)) {
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
        // Why dropped rather than converted: a preview used to be an editor tab whose id encoded
        // the document, and its document was never persisted — so this chrome has always come back
        // naming a file no restore produces, which is the empty pane the surface was reported for.
        // A preview is a browser tab now, and the worktree id inside that encoded id can itself
        // contain the separator, so re-deriving the document from it is guesswork. The reader
        // reopens the preview; nothing is left pointing at a surface that cannot exist.
        if (tab.contentType === 'editor' && tab.entityId.startsWith('html-preview::')) {
          return false
        }
        if (!isTransientEditorContentType(tab.contentType)) {
          return true
        }
        // Why: restore skips backing editor state for transient diff/conflict
        // items. Hydration must drop their tab chrome too or the split group
        // comes back pointing at a document that no longer exists.
        return persistedEditFileIds.has(tab.entityId)
      })
      .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    // Why after the sort: the surviving record is the one the strip renders first.
    tabsByWorktree[worktreeId] = dedupeTabsById(hydratedTabs)
  }

  for (const [worktreeId, groups] of Object.entries(session.tabGroups!)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    if (groups.length === 0) {
      continue
    }

    const validTabIds = new Set((tabsByWorktree[worktreeId] ?? []).map((t) => t.id))
    const validatedGroups = groups.map((g) => {
      // Why: persisted tabOrder can contain duplicates from older buggy
      // writes. Deduping during hydration restores the store invariant before
      // later group operations branch on tab counts or neighbors.
      const tabOrder = dedupeTabOrder(g.tabOrder.filter((tid) => validTabIds.has(tid)))
      const activeTabId = g.activeTabId && validTabIds.has(g.activeTabId) ? g.activeTabId : null
      // Why: persisted MRU may reference tabs that no longer exist. Sanitize
      // against the live tabOrder, then ensure the current active tab sits at
      // the tail so the first close after restore jumps back to the previous
      // tab rather than falling through to neighbor selection.
      const sanitizedRecent = sanitizeRecentTabIds(g.recentTabIds, tabOrder)
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

function hydrateLegacyFormat(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  const tabsByWorktree: Record<string, Tab[]> = {}
  const groupsByWorktree: Record<string, TabGroup[]> = {}
  const activeGroupIdByWorktree: Record<string, string> = {}
  const layoutByWorktree: Record<string, TabGroupLayoutNode> = {}

  for (const worktreeId of validWorktreeIds) {
    const terminalTabs = (session.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
      isValidTerminalTabId(tab.id)
    )
    const editorFiles = session.openFilesByWorktree?.[worktreeId] ?? []

    if (terminalTabs.length === 0 && editorFiles.length === 0) {
      continue
    }

    const groupId = createBrowserUuid()
    const tabs: Tab[] = []
    const tabOrder: string[] = []

    for (const tt of terminalTabs) {
      tabs.push({
        id: tt.id,
        entityId: tt.id,
        groupId,
        worktreeId,
        contentType: 'terminal',
        label: tt.title,
        ...(tt.quickCommandLabel?.trim() ? { quickCommandLabel: tt.quickCommandLabel.trim() } : {}),
        ...(tt.generatedTitle?.trim() ? { generatedLabel: tt.generatedTitle.trim() } : {}),
        customLabel: tt.customTitle,
        color: tt.color,
        sortOrder: tt.sortOrder,
        createdAt: tt.createdAt,
        isPreview: false,
        isPinned: false
      })
      tabOrder.push(tt.id)
    }

    for (const ef of editorFiles) {
      tabs.push({
        id: ef.filePath,
        entityId: ef.filePath,
        groupId,
        worktreeId,
        contentType: 'editor',
        label: ef.relativePath,
        customLabel: null,
        color: null,
        sortOrder: tabs.length,
        createdAt: Date.now(),
        isPreview: ef.isPreview,
        isPinned: false
      })
      tabOrder.push(ef.filePath)
    }

    const activeTabType = session.activeTabTypeByWorktree?.[worktreeId] ?? 'terminal'
    let activeTabId: string | null = null
    if (activeTabType === 'editor') {
      activeTabId = session.activeFileIdByWorktree?.[worktreeId] ?? null
    } else {
      // Why: honor this worktree's own remembered terminal before the global
      // active tab. The global session.activeTabId only names the last-focused
      // worktree's tab, so using it here reset every other worktree to its
      // first terminal on restart.
      const rememberedTabId = session.activeTabIdByWorktree?.[worktreeId]
      if (rememberedTabId && terminalTabs.some((t) => t.id === rememberedTabId)) {
        activeTabId = rememberedTabId
      } else if (session.activeTabId && terminalTabs.some((t) => t.id === session.activeTabId)) {
        activeTabId = session.activeTabId
      }
    }
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      activeTabId = tabs[0]?.id ?? null
    }

    tabsByWorktree[worktreeId] = tabs
    groupsByWorktree[worktreeId] = [
      {
        id: groupId,
        worktreeId,
        activeTabId,
        tabOrder,
        // Why: legacy sessions don't persist MRU; seed with the active tab so
        // the first close after a legacy restore still behaves MRU-ish (falls
        // back to neighbor selection if only one tab is in the stack).
        recentTabIds: activeTabId ? [activeTabId] : []
      }
    ]
    activeGroupIdByWorktree[worktreeId] = groupId
    layoutByWorktree[worktreeId] = { type: 'leaf', groupId }
  }

  return {
    unifiedTabsByWorktree: tabsByWorktree,
    groupsByWorktree,
    activeGroupIdByWorktree,
    layoutByWorktree
  }
}

export function buildHydratedTabState(
  session: WorkspaceSessionState,
  validWorktreeIds: Set<string>
): HydratedTabState {
  if (session.unifiedTabs && session.tabGroups) {
    return hydrateUnifiedFormat(session, validWorktreeIds)
  }
  return hydrateLegacyFormat(session, validWorktreeIds)
}
