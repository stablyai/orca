// Builds frame slices only and never calls set: the store patch applies what it returns.
// Slices rebuilt from a frame, with each tab the window's own command still holds put back as the
// store shows it (present, gone, or where the window placed it), and the rest as main has it. A
// group's order keeps main's for the tabs nothing holds.

import type { Tab, TabGroup } from '../../../shared/tab-types'
import { isEditorTabContentType } from './slices/editor/tabs/editor-tab-content-type'
import type { LayoutFrameSlices } from './workspace-layout-frame-slices'
import type { LayoutFrameStoreState } from './workspace-layout-frame-store-patch'

export type HeldDrawnTabs = {
  /** By tab-bar or entity id. */
  isTabHeld: (workspace: string, id: string) => boolean
  isGroupLayoutHeld: (workspace: string) => boolean
}

export const NO_HELD_TABS: HeldDrawnTabs = {
  isTabHeld: () => false,
  isGroupLayoutHeld: () => false
}

/** `built`'s records with the held ones as `existing` has them: kept, dropped or added. */
function asDrawn<T>(
  existing: readonly T[] | undefined,
  built: T[] | undefined,
  heldIds: ReadonlySet<string>,
  idOf: (record: T) => string
): T[] | undefined {
  const drawn = new Map(
    (existing ?? []).filter((record) => heldIds.has(idOf(record))).map((r) => [idOf(r), r])
  )
  if (drawn.size === 0 && !(built ?? []).some((record) => heldIds.has(idOf(record)))) {
    return built
  }
  const builtIds = new Set((built ?? []).map(idOf))
  const records = [
    ...(built ?? []).flatMap((record) => {
      const id = idOf(record)
      return heldIds.has(id) ? (drawn.has(id) ? [drawn.get(id)!] : []) : [record]
    }),
    ...[...drawn.values()].filter((record) => !builtIds.has(idOf(record)))
  ]
  return records.length > 0 || built ? records : undefined
}

/** Main's order without the held tabs, each held tab put back after its neighbour in the store. */
function heldOrder(
  built: TabGroup | undefined,
  existing: TabGroup | undefined,
  heldIds: ReadonlySet<string>
): string[] {
  const order = (built?.tabOrder ?? []).filter((id) => !heldIds.has(id))
  const drawnOrder = existing?.tabOrder ?? []
  drawnOrder.forEach((id, index) => {
    if (!heldIds.has(id)) {
      return
    }
    const before = drawnOrder
      .slice(0, index)
      .toReversed()
      .find((previous) => order.includes(previous))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id)
  })
  return order
}

function heldGroups(
  existing: readonly TabGroup[],
  built: readonly TabGroup[],
  heldIds: ReadonlySet<string>
): TabGroup[] {
  const touches = (group: TabGroup | undefined): boolean =>
    group?.tabOrder.some((id) => heldIds.has(id)) ?? false
  const existingById = new Map(existing.map((group) => [group.id, group]))
  const builtIds = new Set(built.map((group) => group.id))
  const reconcile = (main: TabGroup | undefined, drawn: TabGroup | undefined): TabGroup[] => {
    if (!touches(main) && !touches(drawn)) {
      return main ? [main] : []
    }
    const tabOrder = heldOrder(main, drawn, heldIds)
    // A group only main still has, left with no tab: the window closed or moved its last one.
    if (!drawn && tabOrder.length === 0) {
      return []
    }
    const base = (drawn ?? main)!
    const activeTabId =
      [drawn?.activeTabId, main?.activeTabId].find((id) => id && tabOrder.includes(id)) ??
      tabOrder[0] ??
      null
    return [{ ...base, tabOrder, activeTabId }]
  }
  return [
    ...built.flatMap((group) => reconcile(group, existingById.get(group.id))),
    ...existing
      .filter((group) => !builtIds.has(group.id) && touches(group))
      .flatMap((group) => reconcile(undefined, group))
  ]
}

function entityIds(tabs: readonly Tab[], kind: (tab: Tab) => boolean): Set<string> {
  return new Set(tabs.filter(kind).map((tab) => tab.entityId))
}

/** `built` for `keys`, with every tab `held` names as `state` draws it. */
export function withHeldTabsAsDrawn(
  state: LayoutFrameStoreState,
  built: LayoutFrameSlices,
  keys: readonly string[],
  held: HeldDrawnTabs
): LayoutFrameSlices {
  let next = built
  for (const key of keys) {
    const isHeld = (tab: Tab): boolean =>
      held.isTabHeld(key, tab.id) || held.isTabHeld(key, tab.entityId)
    const heldTabs = [
      ...(state.unifiedTabsByWorktree[key] ?? []),
      ...(built.unifiedTabsByWorktree[key] ?? [])
    ].filter(isHeld)
    const layoutHeld = held.isGroupLayoutHeld(key)
    if (heldTabs.length === 0 && !layoutHeld) {
      continue
    }
    const heldIds = new Set(heldTabs.map((tab) => tab.id))
    const groups = heldGroups(
      state.groupsByWorktree[key] ?? [],
      next.groupsByWorktree[key] ?? [],
      heldIds
    )
    const groupIds = (list: readonly TabGroup[]): string =>
      list
        .map((group) => group.id)
        .sort()
        .join('\0')
    const layout =
      layoutHeld || groupIds(groups) !== groupIds(next.groupsByWorktree[key] ?? [])
        ? state.layoutByWorktree[key]
        : next.layoutByWorktree[key]
    const terminals = entityIds(heldTabs, (tab) => tab.contentType === 'terminal')
    const browsers = entityIds(heldTabs, (tab) => tab.contentType === 'browser')
    const files = entityIds(heldTabs, (tab) => isEditorTabContentType(tab.contentType))

    const terminalLayouts = { ...next.terminalLayoutsByTabId }
    for (const id of terminals) {
      if (id in state.terminalLayoutsByTabId) {
        terminalLayouts[id] = state.terminalLayoutsByTabId[id]!
      } else {
        delete terminalLayouts[id]
      }
    }
    // A browser tab or file the window closed brings back none of its pages or record.
    const drawnBrowsers = new Set((state.browserTabsByWorktree[key] ?? []).map((tab) => tab.id))
    const closedBrowsers = [...browsers].filter((id) => !drawnBrowsers.has(id))
    const closedPages = new Set(
      closedBrowsers.flatMap((id) => (next.browserPagesByWorkspace[id] ?? []).map((p) => p.id))
    )
    const drawnFiles = new Set(
      state.openFiles.filter((file) => file.worktreeId === key).map((file) => file.id)
    )
    next = {
      ...next,
      unifiedTabsByWorktree: withKey(
        next.unifiedTabsByWorktree,
        key,
        asDrawn(state.unifiedTabsByWorktree[key], next.unifiedTabsByWorktree[key], heldIds, idOf)
      ),
      groupsByWorktree: withKey(next.groupsByWorktree, key, groups),
      layoutByWorktree: withKey(next.layoutByWorktree, key, layout),
      tabsByWorktree: withKey(
        next.tabsByWorktree,
        key,
        asDrawn(state.tabsByWorktree[key], next.tabsByWorktree[key], terminals, idOf)
      ),
      terminalLayoutsByTabId: terminalLayouts,
      browserTabsByWorktree: withKey(
        next.browserTabsByWorktree,
        key,
        asDrawn(state.browserTabsByWorktree[key], next.browserTabsByWorktree[key], browsers, idOf)
      ),
      browserPagesByWorkspace: Object.fromEntries(
        Object.entries(next.browserPagesByWorkspace).filter(([id]) => !closedBrowsers.includes(id))
      ),
      remoteBrowserPageHandlesByPageId: Object.fromEntries(
        Object.entries(next.remoteBrowserPageHandlesByPageId).filter(([id]) => !closedPages.has(id))
      ),
      openFiles: next.openFiles.filter(
        (file) => file.worktreeId !== key || !files.has(file.id) || drawnFiles.has(file.id)
      )
    }
  }
  return next
}

const idOf = (record: { id: string }): string => record.id

function withKey<T>(map: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
  if (value === undefined) {
    const { [key]: _removed, ...rest } = map
    return rest
  }
  return { ...map, [key]: value }
}
