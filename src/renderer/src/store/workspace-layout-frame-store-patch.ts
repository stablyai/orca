// Patch framed workspaces, reusing equal objects to avoid rerenders and retaining window-owned terminal/editor/page state. Every built patch applies and records staged browser handover (L284).

import { BROWSER_TAB_LAYOUT_FIELDS } from '../../../shared/workspace-layout/workspace-layout-beside'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { isEditorTabContentType } from './slices/editor/tabs/editor-tab-content-type'
import type { AppState } from './types'
import type { SessionSourceEdit } from './session-source-edits'
import type { Entry } from './session-source-write-types'
import type { LayoutFrameSlices } from './workspace-layout-frame-slices'
import {
  NO_HELD_TABS,
  withHeldTabsAsDrawn,
  type HeldDrawnTabs
} from './workspace-layout-frame-held-tabs'
import { noteFramesTakingOverStagedBrowserTabs } from './workspace-layout-frame-browser-handover'

/** Keep window spawn/recovery and live bindings; main publishes saved bindings until it owns live ones. */
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

function setKey<F extends KeyedSlice | 'terminalLayoutsByTabId'>(
  edit: SessionSourceEdit<LayoutFrameStoreState>,
  field: F,
  key: string,
  value: Entry<LayoutFrameStoreState, F> | undefined
): void {
  const prior = edit.entry(field, key)
  // A workspace may omit empty records and selections.
  if ((isEmpty(prior) && isEmpty(value)) || same(prior, value)) {
    return
  }
  if (value === undefined) {
    edit.remove(field, key)
  } else {
    edit.set(field, key, value)
  }
}

/**
 * The store patch that shows `built` for `keys`; slices of other workspaces are untouched.
 * Returns only the slices that changed.
 */
export function buildLayoutFrameStorePatch(
  edit: SessionSourceEdit<LayoutFrameStoreState>,
  frameSlices: LayoutFrameSlices,
  keys: readonly string[],
  /** A tab whose pane layout stays as the store has it: the window's own pane command holds it. */
  keepsTerminalLayout: (tabId: string) => boolean = () => false,
  /** This window's own fields for a row the frame creates. */
  newRowFields: (tabId: string) => Partial<TerminalTab> | null = () => null,
  /** Tabs the window drew, closed or moved before main answered: they stay as the store has them. */
  held: HeldDrawnTabs = NO_HELD_TABS
): void {
  const state = edit.view()
  const built = withHeldTabsAsDrawn(state, frameSlices, keys, held)
  const keyed = <F extends KeyedSlice>(
    slice: F,
    value: (key: string) => Entry<LayoutFrameStoreState, F> | undefined
  ): void => {
    for (const key of keys) {
      setKey(edit, slice, key, value(key))
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
  for (const tabId of new Set([
    ...tabIdsOf(state.tabsByWorktree),
    ...tabIdsOf(built.tabsByWorktree)
  ])) {
    if (
      keepsTerminalLayout(tabId) &&
      edit.has('terminalLayoutsByTabId', tabId) &&
      tabId in built.terminalLayoutsByTabId
    ) {
      continue
    }
    setKey(edit, 'terminalLayoutsByTabId', tabId, built.terminalLayoutsByTabId[tabId])
  }

  const keySet = new Set(keys)
  // Keep window editor state. Frames carry edit-mode files; diff/preview/conflict records leave with their last tab, while unshown conflict-review selections stay.
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
  if (state.openFiles.some((file) => !keeps(file))) {
    edit.sequence('openFiles').filter(keeps)
  }
  const addedFiles = built.openFiles.filter((file) => !heldFileIds.has(file.id))
  if (addedFiles.length) {
    edit.sequence('openFiles').append(...addedFiles)
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
  noteFramesTakingOverStagedBrowserTabs(state, built, closedBrowserTabIds, builtBrowserTabIds)
  const closedPageIds = new Set(
    closedBrowserTabIds.flatMap((id) =>
      (state.browserPagesByWorkspace[id] ?? []).map((page) => page.id)
    )
  )
  edit.removeKeys('browserPagesByWorkspace', closedBrowserTabIds)
  edit.removeKeys('remoteBrowserPageHandlesByPageId', closedPageIds)
  for (const [id, pages] of Object.entries(built.browserPagesByWorkspace)) {
    if (!edit.has('browserPagesByWorkspace', id)) {
      edit.set('browserPagesByWorkspace', id, pages)
    }
  }
  for (const [id, handle] of Object.entries(built.remoteBrowserPageHandlesByPageId)) {
    if (!edit.has('remoteBrowserPageHandlesByPageId', id)) {
      edit.set('remoteBrowserPageHandlesByPageId', id, handle)
    }
  }
}
