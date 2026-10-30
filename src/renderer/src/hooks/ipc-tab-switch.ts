import { useAppStore } from '../store'
import { getActiveTabNavOrder } from '@/components/tab-bar/group-tab-order'
import {
  getActiveEntityIdForTabType,
  getNextTabAcrossAllTypes,
  getNextTabWithinActiveType,
  getPreviousRecentTab,
  type TypeCyclableTab
} from '@/components/terminal/tab-type-cycle'
import { activateCycledTabOnOwner } from '@/lib/cycled-tab-owner-activation'

type AppStoreState = ReturnType<typeof useAppStore.getState>

type CycleContext = {
  store: AppStoreState
  worktreeId: string
  allTabIds: TypeCyclableTab[]
  groupTabIdInNav: string | null
}

/** Resolve active workspace/nav for either cycle action; null means nothing to cycle. */
function resolveCycleContext(): CycleContext | null {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return null
  }
  // Cycle the visible group’s order so keyboard navigation follows dragged tabs.
  const allTabIds = getActiveTabNavOrder(store, worktreeId)
  if (allTabIds.length <= 1) {
    return null
  }
  const activeGroupId = store.activeGroupIdByWorktree[worktreeId]
  const group = activeGroupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === activeGroupId)
    : undefined
  // Prefer exact unified tab IDs for split copies; fall back to backing IDs only without a valid group selection, keeping ID domains separate.
  const groupTabIdInNav =
    group?.activeTabId && allTabIds.some((entry) => entry.tabId === group.activeTabId)
      ? group.activeTabId
      : null
  return { store, worktreeId, allTabIds, groupTabIdInNav }
}

/** Activate by unified tab ID after file/browser updates so duplicate entities focus the correct split instance. */
export function activateCyclableTab(store: AppStoreState, next: TypeCyclableTab): void {
  const worktreeId = store.activeWorktreeId
  if (next.type === 'terminal') {
    store.setActiveTab(next.id)
    // Legacy terminal entity activation can choose another split copy; finish with exact unified ID.
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('terminal', worktreeId)
  } else if (next.type === 'browser') {
    store.setActiveBrowserTab(next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('browser', worktreeId)
  } else if (next.type === 'simulator') {
    store.setActiveTab(next.tabId ?? next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('simulator', worktreeId)
  } else if (next.type === 'agent-session') {
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('agent-session', worktreeId)
  } else {
    // setActiveFile selects the entity; activateTab disambiguates its split copy.
    store.setActiveFile(next.id)
    if (next.tabId) {
      store.activateTab?.(next.tabId)
    }
    store.setActiveTabType('editor', worktreeId)
  }
  activateCycledTabOnOwner(worktreeId, next)
}

/** Cycle the current type. Fresh installs use Cmd/Ctrl+Alt+[ / ]; migrated bindings may retain the inverse and remain rebindable. */
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

/** Cycle all visible types. Fresh installs use Cmd/Ctrl+Shift+[ / ]; migrated bindings may retain the inverse and remain rebindable. */
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

  // Only empty group projection proves hydration gaps; do not cross splits whose populated editor/browser rows intentionally exclude terminals.
  const hasPopulatedNonterminalRows = activeGroupNavTabs.some((tab) => tab.type !== 'terminal')
  const groupTerminalTabs = unifiedTerminalTabs.filter((tab) => tab.groupId === activeGroup.id)
  const visibleTerminalEntityIds = new Set(activeGroupTerminalTabs.map((tab) => tab.id))
  if (groupTerminalTabs.some((tab) => !visibleTerminalEntityIds.has(tab.entityId))) {
    return true
  }
  if (activeGroupTerminalTabs.length === 0 && hasPopulatedNonterminalRows) {
    return groupTerminalTabs.length > 0
  }

  // One group can recover absent runtime rows as hydration gaps; multiple one-terminal groups intentionally no-op.
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

/** Ctrl+Tab quick-toggles MRU across visible types in the active group. */
export function handleSwitchRecentTab(): boolean {
  const ctx = resolveCycleContext()
  if (!ctx) {
    return false
  }
  const { store, worktreeId, allTabIds, groupTabIdInNav } = ctx
  const groupId = store.activeGroupIdByWorktree[worktreeId]
  const group = groupId
    ? (store.groupsByWorktree[worktreeId] ?? []).find((candidate) => candidate.id === groupId)
    : undefined
  const next = getPreviousRecentTab(allTabIds, group?.recentTabIds, groupTabIdInNav)
  if (!next) {
    return false
  }

  activateCyclableTab(store, next)
  return true
}

/** Ctrl+PageUp/PageDown cycle visible terminal tabs only. */
export function handleSwitchTerminalTab(direction: number): boolean {
  const store = useAppStore.getState()
  const worktreeId = store.activeWorktreeId
  if (!worktreeId) {
    return false
  }
  // Reuse visible order so terminal-only cycling follows drag order too.
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
  // Prefiltered terminal navigation must use the active entity’s domain, never a stale background terminal ID under structured focus.
  const activeTab = store.getActiveTab(worktreeId)
  const currentId = getActiveEntityIdForTabType(
    store.activeTabType,
    store.activeTabId,
    store.activeFileId,
    store.activeBrowserTabId,
    activeTab?.contentType === 'agent-session' ? activeTab.entityId : null
  )
  // From another tab type, forward navigation starts at the first terminal rather than skipping it.
  const idx = terminalTabs.findIndex((t) => t.id === currentId)
  // A sole terminal no-ops only when already focused; other active types must still jump to it.
  if (terminalTabs.length === 1 && idx === 0) {
    return false
  }
  const currentIndex = idx === -1 && direction > 0 ? -1 : idx === -1 ? 0 : idx
  const next = terminalTabs[(currentIndex + direction + terminalTabs.length) % terminalTabs.length]
  // Skip redundant activation writes to avoid unnecessary active-tab subscriber work.
  if (next.id === store.activeTabId && store.activeTabType === 'terminal') {
    return false
  }
  store.setActiveTab(next.id)
  store.setActiveTabType('terminal', worktreeId)
  activateCycledTabOnOwner(worktreeId, next)
  return true
}
