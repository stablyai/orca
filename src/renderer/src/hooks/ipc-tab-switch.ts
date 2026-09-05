import { useAppStore } from '../store'
import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'
import {
  getActiveEntityIdForTabType,
  getNextTabAcrossAllTypes,
  getNextTabWithinActiveType,
  type TypeCyclableTab
} from '@/components/terminal/tab-type-cycle'
import { sanitizeRecentTabIds } from '../store/slices/tab-group-state'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type CycleContext = {
  store: AppStoreState
  worktreeId: string
  allTabIds: TypeCyclableTab[]
  groupTabIdInNav: string | null
}

/**
 * Shared setup for the type-scoped and across-all-types tab-cycle actions.
 * Returns null when there is no active worktree or the visible nav has at most
 * one tab (nothing to cycle).
 */
function resolveCycleContext(): CycleContext | null {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  // Why: walk the active group's visible order so drag-reordered tabs cycle
  // in the sequence the user sees. See getActiveTabNavOrder for the stale
  // legacy-order bug this replaces.
  const allTabIds = getActiveTabNavOrder(store, worktreeId)
  if (allTabIds.length <= 1) {
    return null
  }
  const activeGroupId = store.activeGroupIdByWorktree[worktreeId]
  const group = activeGroupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === activeGroupId)
    : undefined
  // Why: prefer the active group's unified tab id so split layouts disambiguate
  // which copy of a same-entity tab is focused. Match strictly against `tabId`
  // in that path; only fall back to backing-id matching when the group path
  // doesn't apply (no group, or its activeTabId isn't in the visible nav —
  // e.g. hydration races). Keeping the two domains in separate branches
  // prevents a backing id from colliding with an unrelated tab's `tabId`.
  const groupTabIdInNav =
    group?.activeTabId && allTabIds.some((entry) => entry.tabId === group.activeTabId)
      ? group.activeTabId
      : null
  return { store, worktreeId, allTabIds, groupTabIdInNav }
}

/**
 * Apply the next-tab selection to the store. Preserves the split-layout
 * disambiguation: `activateTab(tabId)` is required on the file/browser
 * branches so that when the same entity is open in multiple splits, the
 * correct tab instance is focused.
 */
export function activateCyclableTab(store: AppStoreState, next: TypeCyclableTab): void {
  if (next.type === 'terminal') {
    store.setActiveTab(next.id)
    // Terminal entities can be open in multiple split groups. setActiveTab uses the legacy
    // entity id and therefore may pick the first copy; the unified id restores the exact target.
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('terminal')
  } else if (next.type === 'browser') {
    store.setActiveBrowserTab(next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('browser')
  } else if (next.type === 'simulator') {
    store.setActiveTab(next.tabId ?? next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('simulator')
  } else if (next.type === 'agent-session') {
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('agent-session')
  } else {
    // Why: `setActiveFile` targets the file entity (its implicit activateTab
    // picks the first matching tab in the active group); `activateTab(tabId)`
    // then disambiguates which split copy when the same file is open twice.
    store.setActiveFile(next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('editor')
  }
}

/**
 * Handle direction switching within the active tab type (same-type cycle).
 * The default chord is Cmd/Ctrl+Alt+[ / ] for fresh installs; pre-swap installs
 * keep Cmd/Ctrl+Shift+[ / ] via the seed migration, and either is rebindable.
 * Extracted from useIpcEvents to keep file size under the max-lines lint threshold.
 * Returns true if a tab switch occurred, false otherwise.
 */
export function handleSwitchTab(direction: number): boolean {
  const ctx = resolveCycleContext()
  if (!ctx) {
    return false
  }
  const { store, allTabIds, groupTabIdInNav } = ctx
  const next = getNextTabWithinActiveType({
    tabs: allTabIds,
    activeTabType: store.activeTabType,
    activeTabId: store.activeTabId,
    activeFileId: store.activeFileId,
    activeBrowserTabId: store.activeBrowserTabId,
    activeGroupTabId: groupTabIdInNav,
    direction
  })
  if (!next) {
    return false
  }
  activateCyclableTab(store, next)
  return true
}

/**
 * Handle cycling across every visible tab, regardless of tab type.
 *
 * Why: companion chord to the type-scoped same-type cycle. Fresh installs bind
 * this broad cycle to Cmd/Ctrl+Shift+[ / ] — the widespread "switch tab" chord —
 * and the same-type cycle to Cmd/Ctrl+Alt+[ / ]; pre-swap installs keep the
 * inverse via the seed migration (see PR #1281 for the original type-scope
 * rationale). Returns true if a tab switch occurred, false otherwise.
 */
export function handleSwitchTabAcrossAllTypes(direction: number): boolean {
  const ctx = resolveCycleContext()
  if (!ctx) {
    return false
  }
  const { store, allTabIds, groupTabIdInNav } = ctx
  const next = getNextTabAcrossAllTypes({
    tabs: allTabIds,
    activeTabType: store.activeTabType,
    activeTabId: store.activeTabId,
    activeFileId: store.activeFileId,
    activeBrowserTabId: store.activeBrowserTabId,
    activeGroupTabId: groupTabIdInNav,
    direction
  })
  if (!next) {
    return false
  }
  activateCyclableTab(store, next)
  return true
}

/** Build a stable worktree-wide terminal order for a temporarily incomplete group projection. */
function getWorktreeTerminalTabOrder(store: AppStoreState, worktreeId: string): TypeCyclableTab[] {
  const runtimeTabs = store.tabsByWorktree?.[worktreeId] ?? []
  const unifiedTerminalTabs = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  const activeGroupId = store.activeGroupIdByWorktree?.[worktreeId]
  const unifiedByEntity = new Map<string, typeof unifiedTerminalTabs>()
  for (const tab of unifiedTerminalTabs) {
    const existing = unifiedByEntity.get(tab.entityId)
    if (existing) {
      existing.push(tab)
    } else {
      unifiedByEntity.set(tab.entityId, [tab])
    }
  }

  const resolveTabId = (entityId: string): string | undefined => {
    const matches = unifiedByEntity.get(entityId) ?? []
    // Keep split activation exact when the active group has one unambiguous copy.
    const activeGroupMatch = activeGroupId
      ? matches.filter((tab) => tab.groupId === activeGroupId)
      : []
    if (activeGroupMatch.length === 1) {
      return activeGroupMatch[0].id
    }
    return matches.length === 1 ? matches[0].id : undefined
  }

  const result: TypeCyclableTab[] = []
  const seenEntityIds = new Set<string>()
  for (const tab of runtimeTabs) {
    if (seenEntityIds.has(tab.id)) {
      continue
    }
    seenEntityIds.add(tab.id)
    const tabId = resolveTabId(tab.id)
    result.push({ type: 'terminal', id: tab.id, ...(tabId ? { tabId } : {}) })
  }
  // Unified rows can arrive before their legacy runtime rows during hydration.
  for (const tab of unifiedTerminalTabs) {
    if (seenEntityIds.has(tab.entityId)) {
      continue
    }
    seenEntityIds.add(tab.entityId)
    result.push({ type: 'terminal', id: tab.entityId, tabId: tab.id })
  }
  return result
}

/** Return true only when a short active-group list is attributable to stale hydration. */
function shouldUseWorktreeTerminalFallback(
  store: AppStoreState,
  worktreeId: string,
  activeGroupNavTabs: readonly TypeCyclableTab[],
  activeGroupTerminalTabs: readonly TypeCyclableTab[],
  worktreeTerminalTabs: readonly TypeCyclableTab[]
): boolean {
  if (
    activeGroupTerminalTabs.length >= 2 ||
    worktreeTerminalTabs.length <= activeGroupTerminalTabs.length
  ) {
    return false
  }
  const groups = store.groupsByWorktree?.[worktreeId] ?? []
  const activeGroupId = store.activeGroupIdByWorktree?.[worktreeId]
  const activeGroup = activeGroupId ? groups.find((group) => group.id === activeGroupId) : undefined
  if (!activeGroup) {
    return true
  }

  const unifiedTerminalTabs = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'terminal'
  )
  if (unifiedTerminalTabs.length === 0) {
    return true
  }
  const allUnifiedEntityIds = new Set(unifiedTerminalTabs.map((tab) => tab.entityId))
  const runtimeIdsMissingFromUnified = worktreeTerminalTabs.some(
    (tab) => !allUnifiedEntityIds.has(tab.id)
  )
  if (runtimeIdsMissingFromUnified) {
    return true
  }

  // An empty projection is only a hydration gap when the active group itself has no
  // populated rows. If it has editor/browser rows and every runtime terminal is declared
  // in another group, crossing that split would surprise the user.
  const hasPopulatedNonterminalRows = activeGroupNavTabs.some((tab) => tab.type !== 'terminal')
  const groupTerminalTabs = unifiedTerminalTabs.filter((tab) => tab.groupId === activeGroup.id)
  const visibleTerminalEntityIds = new Set(activeGroupTerminalTabs.map((tab) => tab.id))
  if (groupTerminalTabs.some((tab) => !visibleTerminalEntityIds.has(tab.entityId))) {
    return true
  }
  if (activeGroupTerminalTabs.length === 0 && hasPopulatedNonterminalRows) {
    return groupTerminalTabs.length > 0
  }

  // With one group, a runtime row outside that group's model is a hydration gap. Multiple groups
  // may legitimately have one terminal each, so keep that split-local no-op intact.
  const declaredGroupTabIds = new Set(activeGroup.tabOrder ?? [])
  if (groupTerminalTabs.some((tab) => !declaredGroupTabIds.has(tab.id))) {
    return true
  }
  if (groups.length <= 1) {
    const activeGroupEntityIds = new Set(groupTerminalTabs.map((tab) => tab.entityId))
    if (worktreeTerminalTabs.some((tab) => !activeGroupEntityIds.has(tab.id))) {
      return true
    }
  }

  if (activeGroup.activeTabId) {
    const activeTab = (store.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
      (tab) => tab.id === activeGroup.activeTabId
    )
    if (!activeTab || activeTab.groupId !== activeGroup.id) {
      return true
    }
  }
  return false
}

/**
 * Handle Ctrl+Tab MRU quick-toggle across every visible tab in the active group.
 * Returns true if a tab switch occurred, false otherwise.
 */
export function handleSwitchRecentTab(): boolean {
  const ctx = resolveCycleContext()
  if (!ctx) {
    return false
  }
  const { store, worktreeId, allTabIds, groupTabIdInNav } = ctx
  if (!groupTabIdInNav) {
    return false
  }
  const groupId = store.activeGroupIdByWorktree[worktreeId]
  const group = groupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === groupId)
    : undefined
  if (!group?.recentTabIds) {
    return false
  }

  const visibleTabIds = allTabIds.flatMap((entry) => (entry.tabId ? [entry.tabId] : []))
  const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, visibleTabIds)
  const currentIndex = recentTabIds.lastIndexOf(groupTabIdInNav)
  if (currentIndex <= 0) {
    return false
  }

  const previousRecentTabId = recentTabIds[currentIndex - 1]
  const next = allTabIds.find((entry) => entry.tabId === previousRecentTabId)
  if (!next) {
    return false
  }

  activateCyclableTab(store, next)
  return true
}

/**
 * Handle Ctrl+PageUp/PageDown switching across terminal tabs only.
 * Returns true if a terminal tab switch occurred, false otherwise.
 */
export function handleSwitchTerminalTab(direction: number): boolean {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  // Why: reuse the same visible-order source as handleSwitchTab so drag-reordered
  // tabs still cycle in the sequence shown in the active tab strip.
  const activeGroupNavTabs = getActiveTabNavOrder(store, worktreeId)
  const activeGroupTerminalTabs = activeGroupNavTabs.filter((entry) => entry.type === 'terminal')
  const worktreeTerminalTabs = getWorktreeTerminalTabOrder(store, worktreeId)
  const terminalTabs = shouldUseWorktreeTerminalFallback(
    store,
    worktreeId,
    activeGroupNavTabs,
    activeGroupTerminalTabs,
    worktreeTerminalTabs
  )
    ? worktreeTerminalTabs
    : activeGroupTerminalTabs
  if (terminalTabs.length === 0) {
    return false
  }
  const currentId = getActiveEntityIdForTabType(
    store.activeTabType,
    store.activeTabId,
    store.activeFileId,
    store.activeBrowserTabId
  )
  // Why: when an editor/browser tab is active, jump to the first terminal on
  // forward navigation instead of skipping to index 1.
  const idx = terminalTabs.findIndex((t) => t.id === currentId)
  // Why: only no-op when the sole terminal is already focused. With one terminal
  // and an editor/browser active, the chord must still jump to that terminal -
  // that is the whole point of the shortcut. The single-terminal-already-active
  // case is the only true no-op.
  if (terminalTabs.length === 1 && idx === 0) {
    return false
  }
  const currentIndex = idx === -1 && direction > 0 ? -1 : idx === -1 ? 0 : idx
  const next = terminalTabs[(currentIndex + direction + terminalTabs.length) % terminalTabs.length]
  // Why: skip the store writes when the target terminal is already the active
  // tab (e.g. single-terminal with that terminal focused but via a different
  // code path). Redundant setActiveTab calls trigger unnecessary subscriber
  // work in components that react to active-tab changes.
  if (next.id === store.activeTabId && store.activeTabType === 'terminal') {
    return false
  }
  store.setActiveTab(next.id)
  store.setActiveTabType('terminal')
  return true
}
