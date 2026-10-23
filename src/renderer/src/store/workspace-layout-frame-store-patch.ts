// Lays slices rebuilt from layout frames over the store for the workspaces frames replaced. A record
// equal to the store's keeps the store's object, so an unchanged frame re-renders nothing; a
// record the store already holds keeps what only this window knows about it (a terminal row's
// in-flight spawn and recovery state, an open file's editor state, a browser tab's page state).

import { BROWSER_TAB_LAYOUT_FIELDS } from '../../../shared/workspace-layout/workspace-layout-beside'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { isEditorTabContentType } from './slices/editor/tabs/editor-tab-content-type'
import type { AppState } from './types'
import type { LayoutFrameSlices } from './workspace-layout-frame-slices'
import {
  NO_HELD_TABS,
  withHeldTabsAsDrawn,
  type HeldDrawnTabs
} from './workspace-layout-frame-held-tabs'

/** Row fields this window owns: what its mounted panes are doing, and which terminal each row
 *  binds (main publishes the saved binding; the live one stays the window's until main owns it). */
const WINDOW_TERMINAL_TAB_FIELDS = [
  'ptyId',
  'pendingActivationSpawn',
  'recovery',
  'restoredFromSession',
  'agentLaunchPane'
] as const satisfies readonly (keyof TerminalTab)[]

type KeyedSlice =
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'

export type LayoutFrameStoreState = Pick<
  AppState,
  KeyedSlice | 'terminalLayoutsByTabId' | 'openFiles' | 'browserPagesByWorkspace'
> &
  Pick<AppState, 'remoteBrowserPageHandlesByPageId'>

function same(a: unknown, b: unknown): boolean {
  return a === b || stableJson(a) === stableJson(b)
}

function withoutWindowFields(tab: TerminalTab): Partial<TerminalTab> {
  const fields: Partial<TerminalTab> = { ...tab }
  for (const field of WINDOW_TERMINAL_TAB_FIELDS) {
    delete fields[field]
  }
  return fields
}

function mergeTerminalRow(
  existing: TerminalTab | undefined,
  built: TerminalTab,
  newRowFields: (tabId: string) => Partial<TerminalTab> | null
): TerminalTab {
  if (!existing) {
    const fields = newRowFields(built.id)
    return fields ? { ...built, ...fields } : built
  }
  if (same(withoutWindowFields(existing), withoutWindowFields(built))) {
    return existing
  }
  const merged: TerminalTab = { ...built, ptyId: existing.ptyId }
  for (const field of WINDOW_TERMINAL_TAB_FIELDS) {
    if (field === 'ptyId') {
      continue
    }
    if (existing[field] === undefined) {
      delete merged[field]
    } else {
      Object.assign(merged, { [field]: existing[field] })
    }
  }
  return merged
}

/** Each built record, or the store's when equal; the store's array when every record is. */
function mergeById<T extends { id: string }>(
  existing: T[] | undefined,
  built: readonly T[] | undefined,
  merge: (existing: T | undefined, built: T) => T = (current, next) =>
    current && same(current, next) ? current : next
): T[] | undefined {
  if (!built) {
    return undefined
  }
  const byId = new Map(existing?.map((record) => [record.id, record]))
  const merged = built.map((record) => merge(byId.get(record.id), record))
  return existing &&
    existing.length === merged.length &&
    merged.every((record, index) => record === existing[index])
    ? existing
    : merged
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (Array.isArray(value) && value.length === 0)

function setKey<T>(
  map: Record<string, T>,
  key: string,
  value: T | undefined
): Record<string, T> | null {
  // A workspace with no records or selection of a kind may be listed empty or left out.
  if (isEmpty(map[key]) && isEmpty(value)) {
    return null
  }
  if (map[key] === value || (value !== undefined && key in map && same(map[key], value))) {
    return null
  }
  if (value === undefined) {
    if (!(key in map)) {
      return null
    }
    const { [key]: _removed, ...rest } = map
    return rest
  }
  return { ...map, [key]: value }
}

/**
 * The store patch that shows `built` for `keys`; slices of other workspaces are untouched.
 * Returns only the slices that changed.
 */
export function buildLayoutFrameStorePatch(
  state: LayoutFrameStoreState,
  frameSlices: LayoutFrameSlices,
  keys: readonly string[],
  /** A tab whose pane layout stays as the store has it: the window's own pane command holds it. */
  keepsTerminalLayout: (tabId: string) => boolean = () => false,
  /** This window's own fields for a row the frame creates. */
  newRowFields: (tabId: string) => Partial<TerminalTab> | null = () => null,
  /** Tabs the window drew, closed or moved before main answered: they stay as the store has them. */
  held: HeldDrawnTabs = NO_HELD_TABS
): Partial<LayoutFrameStoreState> {
  const built = withHeldTabsAsDrawn(state, frameSlices, keys, held)
  const patch: Partial<LayoutFrameStoreState> = {}
  const keyed = (slice: KeyedSlice, value: (key: string) => unknown): void => {
    let next: Record<string, unknown> = state[slice]
    for (const key of keys) {
      next = setKey(next, key, value(key)) ?? next
    }
    if (next !== state[slice]) {
      Object.assign(patch, { [slice]: next })
    }
  }

  keyed('tabsByWorktree', (key) =>
    mergeById(state.tabsByWorktree[key], built.tabsByWorktree[key], (existing, next) =>
      mergeTerminalRow(existing, next, newRowFields)
    )
  )
  keyed('unifiedTabsByWorktree', (key) =>
    mergeById(state.unifiedTabsByWorktree[key], built.unifiedTabsByWorktree[key])
  )
  keyed('groupsByWorktree', (key) =>
    mergeById(state.groupsByWorktree[key], built.groupsByWorktree[key])
  )
  keyed('browserTabsByWorktree', (key) =>
    mergeById(
      state.browserTabsByWorktree[key],
      built.browserTabsByWorktree[key],
      (existing, next) => {
        if (!existing) {
          return next
        }
        const layoutFields = (tab: typeof next) =>
          BROWSER_TAB_LAYOUT_FIELDS.map((field) => tab[field])
        // Page state is this window's; main holds only the tab's own fields.
        return same(layoutFields(existing), layoutFields(next))
          ? existing
          : {
              ...existing,
              ...Object.fromEntries(BROWSER_TAB_LAYOUT_FIELDS.map((f) => [f, next[f]]))
            }
      }
    )
  )
  for (const slice of [
    'layoutByWorktree',
    'activeGroupIdByWorktree',
    'activeTabIdByWorktree',
    'activeFileIdByWorktree',
    'activeBrowserTabIdByWorktree',
    'activeTabTypeByWorktree'
  ] as const) {
    keyed(slice, (key) => built[slice][key])
  }

  const tabIdsOf = (tabs: Record<string, readonly TerminalTab[]>): Set<string> =>
    new Set(keys.flatMap((key) => (tabs[key] ?? []).map((tab) => tab.id)))
  let terminalLayouts = state.terminalLayoutsByTabId
  for (const tabId of new Set([
    ...tabIdsOf(state.tabsByWorktree),
    ...tabIdsOf(built.tabsByWorktree)
  ])) {
    if (
      keepsTerminalLayout(tabId) &&
      tabId in terminalLayouts &&
      tabId in built.terminalLayoutsByTabId
    ) {
      continue
    }
    terminalLayouts =
      setKey(terminalLayouts, tabId, built.terminalLayoutsByTabId[tabId]) ?? terminalLayouts
  }
  Object.assign(patch, terminalLayoutsPatch(state, terminalLayouts))

  const keySet = new Set(keys)
  // An open file's editor state is this window's; a frame decides only which files are open.
  // Frames carry only edit-mode files, so a diff, preview or conflict record goes with its last
  // tab, and one no tab shows (a conflict review's selected file) stays.
  const builtFileIds = new Set(built.openFiles.map((file) => file.id))
  const heldFileIds = new Set(state.openFiles.map((file) => file.id))
  const editorEntities = (tabs: AppState['unifiedTabsByWorktree']): Set<string> =>
    new Set(
      keys.flatMap((key) =>
        (tabs[key] ?? []).flatMap((tab) =>
          isEditorTabContentType(tab.contentType) ? [`${key}\0${tab.entityId}`] : []
        )
      )
    )
  const shown = editorEntities(state.unifiedTabsByWorktree)
  const stillShown = editorEntities(built.unifiedTabsByWorktree)
  const keeps = (file: AppState['openFiles'][number]): boolean => {
    const entity = `${file.worktreeId}\0${file.id}`
    return (
      !keySet.has(file.worktreeId) ||
      builtFileIds.has(file.id) ||
      stillShown.has(entity) ||
      !shown.has(entity)
    )
  }
  const files = [
    ...state.openFiles.filter(keeps),
    ...built.openFiles.filter((file) => !heldFileIds.has(file.id))
  ]
  if (
    files.length !== state.openFiles.length ||
    files.some((file, index) => file !== state.openFiles[index])
  ) {
    patch.openFiles = files
  }

  // Pages and handles are this window's: a frame brings those of a tab it has not seen and drops
  // those of a tab main closed.
  const builtBrowserTabIds = new Set(
    keys.flatMap((key) => (built.browserTabsByWorktree[key] ?? []).map((tab) => tab.id))
  )
  const closedBrowserTabIds = keys
    .flatMap((key) => state.browserTabsByWorktree[key] ?? [])
    .map((tab) => tab.id)
    .filter((id) => !builtBrowserTabIds.has(id))
  const closedPageIds = new Set(
    closedBrowserTabIds.flatMap((id) =>
      (state.browserPagesByWorkspace[id] ?? []).map((page) => page.id)
    )
  )
  const pages = { ...state.browserPagesByWorkspace }
  for (const id of closedBrowserTabIds) {
    delete pages[id]
  }
  const handles = Object.fromEntries(
    Object.entries(state.remoteBrowserPageHandlesByPageId).filter(([id]) => !closedPageIds.has(id))
  )
  const addedPages = Object.entries(built.browserPagesByWorkspace).filter(([id]) => !(id in pages))
  const addedHandles = Object.entries(built.remoteBrowserPageHandlesByPageId).filter(
    ([id]) => !(id in handles)
  )
  if (closedBrowserTabIds.length > 0 || addedPages.length > 0) {
    patch.browserPagesByWorkspace = { ...pages, ...Object.fromEntries(addedPages) }
  }
  if (closedPageIds.size > 0 || addedHandles.length > 0) {
    patch.remoteBrowserPageHandlesByPageId = { ...handles, ...Object.fromEntries(addedHandles) }
  }
  return patch
}

/** The patch that shows `layouts` as the store's pane trees; empty when they are the store's. */
export function terminalLayoutsPatch(
  state: Pick<LayoutFrameStoreState, 'terminalLayoutsByTabId'>,
  layouts: LayoutFrameStoreState['terminalLayoutsByTabId']
): Partial<LayoutFrameStoreState> {
  return layouts === state.terminalLayoutsByTabId ? {} : { terminalLayoutsByTabId: layouts }
}
