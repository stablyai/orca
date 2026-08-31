import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../../store/types'
import { reconcileTabOrder } from './reconcile-order'

export type VisibleTabRef = {
  type: 'terminal' | 'editor' | 'agent-session' | 'browser' | 'simulator'
  id: string
  tabId?: string
}

export type ActiveTabNavOrderIds = {
  terminalIds?: string[]
  editorIds?: string[]
  browserIds?: string[]
  simulatorIds?: string[]
  agentSessionIds?: string[]
}

/**
 * One group's visible tab-strip order, via the same `reconcileTabOrder` pass TabBar renders with
 * so keyboard cycling always walks what the user sees. STA-3475: dropping a tab that hydrated
 * before `group.tabOrder` knew it left the cycle a silent no-op until a click.
 *
 * `id` is the backing entity/file id legacy activation APIs take; `tabId` is the unified tab id
 * that picks the right split copy. Tabs whose entity is gone are skipped.
 */
export function getGroupVisibleTabOrder(
  group: TabGroup,
  groupTabs: readonly Tab[],
  terminalEntityIds: ReadonlySet<string>,
  editorEntityIds: ReadonlySet<string>,
  browserEntityIds: ReadonlySet<string>,
  simulatorTabIds: ReadonlySet<string> = new Set(),
  preserveTypeCollisions = false
): VisibleTabRef[] {
  const tabsById = new Map(groupTabs.map((t) => [t.id, t]))
  const toRef = (tab: Tab): VisibleTabRef | null => {
    if (tab.contentType === 'terminal') {
      return terminalEntityIds.has(tab.entityId)
        ? { type: 'terminal', id: tab.entityId, tabId: tab.id }
        : null
    }
    if (tab.contentType === 'browser') {
      return browserEntityIds.has(tab.entityId)
        ? { type: 'browser', id: tab.entityId, tabId: tab.id }
        : null
    }
    if (tab.contentType === 'simulator') {
      return simulatorTabIds.has(tab.id) ? { type: 'simulator', id: tab.id, tabId: tab.id } : null
    }
    if (tab.contentType === 'agent-session') {
      // Structured chat tabs are self-backed: the unified tab is the entity, so none can be stale.
      return { type: 'agent-session', id: tab.entityId, tabId: tab.id }
    }
    return editorEntityIds.has(tab.entityId)
      ? { type: 'editor', id: tab.entityId, tabId: tab.id }
      : null
  }
  // Why: the strip keys terminals/browsers by entity id and editors/simulators by unified tab id
  // (see useTabGroupItemProjections) — reconcileTabOrder must see that same id domain.
  const visibleIdOf = (tab: Tab): string =>
    tab.contentType === 'terminal' ||
    tab.contentType === 'browser' ||
    tab.contentType === 'agent-session'
      ? tab.entityId
      : tab.id

  if (preserveTypeCollisions) {
    const seenByType = {
      terminal: new Set<string>(),
      editor: new Set<string>(),
      browser: new Set<string>(),
      simulator: new Set<string>(),
      'agent-session': new Set<string>()
    }
    const result: VisibleTabRef[] = []
    for (const unifiedId of group.tabOrder) {
      const tab = tabsById.get(unifiedId)
      if (!tab) {
        continue
      }
      const ref = toRef(tab)
      if (!ref || seenByType[ref.type].has(visibleIdOf(tab))) {
        continue
      }
      seenByType[ref.type].add(visibleIdOf(tab))
      result.push(ref)
    }
    return result
  }

  // Why: the strip's per-type maps are last-write-wins, so a duplicate entity resolves to the
  // last declared tab while the reconciled visible id still occupies one position.
  const declaredTabs = group.tabOrder.flatMap((unifiedId) => {
    const tab = tabsById.get(unifiedId)
    return tab ? [tab] : []
  })
  const refByVisibleId = new Map<string, VisibleTabRef>()
  const terminalIds: string[] = []
  const editorIds: string[] = []
  const browserIds: string[] = []
  const simulatorIds: string[] = []
  const agentSessionIds: string[] = []
  const idsByType = {
    terminal: terminalIds,
    editor: editorIds,
    browser: browserIds,
    simulator: simulatorIds,
    'agent-session': agentSessionIds
  }
  for (const tab of [...declaredTabs, ...groupTabs]) {
    const visibleId = visibleIdOf(tab)
    const ref = toRef(tab)
    if (!ref) {
      continue
    }
    const existing = refByVisibleId.get(visibleId)
    if (existing) {
      // Keep the same type precedence as buildOrderedTabItems, whose terminal map wins over
      // editor/browser/simulator maps when visible ids collide across content types.
      const priority = {
        terminal: 0,
        editor: 1,
        browser: 2,
        simulator: 3,
        'agent-session': 4
      } as const
      if (priority[ref.type] > priority[existing.type]) {
        continue
      }
      refByVisibleId.set(visibleId, ref)
      continue
    }
    refByVisibleId.set(visibleId, ref)
    idsByType[ref.type].push(visibleId)
  }

  return reconcileTabOrder(
    declaredTabs.map(visibleIdOf),
    terminalIds,
    editorIds,
    browserIds,
    simulatorIds,
    agentSessionIds
  ).flatMap((visibleId) => {
    const ref = refByVisibleId.get(visibleId)
    return ref ? [ref] : []
  })
}

/**
 * Resolve the visible tab order the active surface is showing, for keyboard
 * navigation.
 *
 * Prefers the active group's `group.tabOrder` so drag-reordered tabs cycle
 * in the order the user sees. Falls back to the legacy
 * `tabBarOrderByWorktree` path when no active group exists yet — this covers
 * sessions restored before the split-group model hydrated and the
 * pre-layout titlebar TabBar fallback rendered by Terminal.tsx. The fallback
 * still drifts for drag-reorders (the legacy store never learns about
 * them), but worktrees without a group cannot have split-aware drag in the
 * first place, so in practice only the active-group path matters once
 * layouts are established.
 */
export function getActiveTabNavOrder(
  state: Pick<
    AppState,
    | 'activeGroupIdByWorktree'
    | 'groupsByWorktree'
    | 'unifiedTabsByWorktree'
    | 'tabBarOrderByWorktree'
    | 'tabsByWorktree'
    | 'openFiles'
    | 'browserTabsByWorktree'
  >,
  worktreeId: string,
  ids: ActiveTabNavOrderIds = {}
): VisibleTabRef[] {
  const terminalIds = ids.terminalIds ?? (state.tabsByWorktree[worktreeId] ?? []).map((t) => t.id)
  const editorIds =
    ids.editorIds ?? state.openFiles.filter((f) => f.worktreeId === worktreeId).map((f) => f.id)
  const browserIds =
    ids.browserIds ?? (state.browserTabsByWorktree?.[worktreeId] ?? []).map((t) => t.id)
  const simulatorIds =
    ids.simulatorIds ??
    (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'simulator')
      .map((tab) => tab.id)
  const agentSessionIds =
    ids.agentSessionIds ??
    (state.unifiedTabsByWorktree[worktreeId] ?? [])
      .filter((tab) => tab.contentType === 'agent-session')
      .map((tab) => tab.id)

  const activeGroupId = state.activeGroupIdByWorktree[worktreeId]
  const group = activeGroupId
    ? (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === activeGroupId)
    : undefined

  if (group) {
    const groupTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
      (tab) => tab.groupId === group.id
    )
    // The group strip renders unified terminal tabs before their legacy runtime rows hydrate.
    // Keep those tabs keyboard-cyclable; activation can hydrate/reconnect the backing runtime.
    const groupTerminalIds = new Set([
      ...terminalIds,
      ...groupTabs.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
    ])
    return getGroupVisibleTabOrder(
      group,
      groupTabs,
      groupTerminalIds,
      new Set(editorIds),
      new Set(browserIds),
      new Set(simulatorIds)
    )
  }

  // Legacy fallback: no split-group layout yet for this worktree.
  const visibleIds = reconcileTabOrder(
    state.tabBarOrderByWorktree[worktreeId],
    terminalIds,
    editorIds,
    browserIds,
    simulatorIds,
    agentSessionIds
  )
  const terminalIdSet = new Set(terminalIds)
  const editorIdSet = new Set(editorIds)
  const browserIdSet = new Set(browserIds)
  const simulatorIdSet = new Set(simulatorIds)
  const agentSessionIdSet = new Set(agentSessionIds)
  const result: VisibleTabRef[] = []
  for (const id of visibleIds) {
    if (terminalIdSet.has(id)) {
      result.push({ type: 'terminal', id })
    } else if (editorIdSet.has(id)) {
      result.push({ type: 'editor', id })
    } else if (browserIdSet.has(id)) {
      result.push({ type: 'browser', id })
    } else if (simulatorIdSet.has(id)) {
      result.push({ type: 'simulator', id })
    } else if (agentSessionIdSet.has(id)) {
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === id && candidate.contentType === 'agent-session'
      )
      if (tab) {
        result.push({ type: 'agent-session', id: tab.entityId, tabId: tab.id })
      }
    }
  }
  return result
}
