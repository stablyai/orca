// Track window pane-close reason, moved-tab selection and in-flight drawn-tree holds while main owns frame structure. Unrequested drops await main’s notice; added panes mount/focus unless a local split requested retained focus.

import type { TerminalTab } from '../../../shared/terminal-tab-types'

/** Intents outlive their frame only when a tab never mounts again; keep the newest few. */
const MAX_INTENTS = 64

/** 'user': the user's close, with its status and launch clean-up. 'exit': its terminal ended. */
export type PaneCloseKind = 'user' | 'exit'

const closing = new Map<string, { tabId: string; kind: PaneCloseKind }>()

function remember<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_INTENTS) {
    map.delete(map.keys().next().value!)
  }
}

export function expectPaneToClose(tabId: string, leafId: string, kind: PaneCloseKind): () => void {
  const intent = { tabId, kind }
  remember(closing, leafId, intent)
  return () => {
    if (closing.get(leafId) === intent) {
      closing.delete(leafId)
    }
  }
}

const unfocused = new Map<string, string>()

/** A split of the window's that leaves focus on its source pane (a tab's startup split). */
export function expectPaneToMountUnfocused(tabId: string, leafId: string): () => void {
  remember(unfocused, leafId, tabId)
  return () => {
    if (unfocused.get(leafId) === tabId) {
      unfocused.delete(leafId)
    }
  }
}

export function takePaneMountUnfocused(tabId: string, leafId: string): boolean {
  if (unfocused.get(leafId) !== tabId) {
    return false
  }
  unfocused.delete(leafId)
  return true
}

/** Of these panes, how many no close of this window's is about to take. */
export function panesLeftAfterPendingCloses(tabId: string, leafIds: readonly string[]): number {
  return leafIds.filter((leafId) => closing.get(leafId)?.tabId !== tabId).length
}

export function takePaneCloseIntent(tabId: string, leafId: string): PaneCloseKind | null {
  const intent = closing.get(leafId)
  if (intent?.tabId !== tabId) {
    return null
  }
  closing.delete(leafId)
  return intent.kind
}

/** Row fields only this window knows, for a tab main's frame will create. */
export type TabRowFields = Pick<TerminalTab, 'pendingActivationSpawn'>

const rowFields = new Map<string, TabRowFields>()

export function expectTabRowFields(tabId: string, fields: TabRowFields): () => void {
  remember(rowFields, tabId, fields)
  return () => {
    if (rowFields.get(tabId) === fields) {
      rowFields.delete(tabId)
    }
  }
}

export function takeTabRowFields(tabId: string): TabRowFields | null {
  const fields = rowFields.get(tabId) ?? null
  rowFields.delete(tabId)
  return fields
}

/**
 * A tab the user moved out of `fromGroupId`, selected in the frame flush that shows it moved (L120).
 * `selection` is the workspace's selection the move left (null until known); any other selection
 * by then means the user chose since, and the intent is dropped.
 */
export type MovedTabSelection = {
  worktreeId: string
  tabId: string
  fromGroupId: string
  selection: string | null
}

const movedTabSelections = new Map<string, MovedTabSelection>()

/** A newer move in the workspace replaces any older one's; the returned call drops this one. */
export function expectMovedTabSelection(intent: MovedTabSelection): () => void {
  for (const [tabId, other] of movedTabSelections) {
    if (other.worktreeId === intent.worktreeId) {
      movedTabSelections.delete(tabId)
    }
  }
  remember(movedTabSelections, intent.tabId, intent)
  return () => {
    if (movedTabSelections.get(intent.tabId) === intent) {
      movedTabSelections.delete(intent.tabId)
    }
  }
}

export function pendingMovedTabSelections(): readonly MovedTabSelection[] {
  return [...movedTabSelections.values()]
}

export function dropMovedTabSelection(intent: MovedTabSelection): void {
  if (movedTabSelections.get(intent.tabId) === intent) {
    movedTabSelections.delete(intent.tabId)
  }
}

const heldTabs = new Map<string, number>()
const redrawListeners = new Set<(tabId: string) => void>()

/** Keeps the tab's drawn tree from frames until the release; releasing twice is a no-op. */
export function holdTabPaneTree(tabId: string): () => void {
  heldTabs.set(tabId, (heldTabs.get(tabId) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = (heldTabs.get(tabId) ?? 1) - 1
    if (count > 0) {
      heldTabs.set(tabId, count)
      return
    }
    heldTabs.delete(tabId)
    requestTabPaneTreeRedraw(tabId)
  }
}

/** Shows main's tree for the tab again, as the frames hold it: after a hold, or a zoom ends. */
export function requestTabPaneTreeRedraw(tabId: string): void {
  for (const listener of redrawListeners) {
    listener(tabId)
  }
}

export function isTabPaneTreeHeld(tabId: string): boolean {
  return heldTabs.has(tabId)
}

export function onTabPaneTreeRedraw(listener: (tabId: string) => void): () => void {
  redrawListeners.add(listener)
  return () => redrawListeners.delete(listener)
}

export function _resetLayoutOwnerPaneIntentsForTests(): void {
  closing.clear()
  unfocused.clear()
  rowFields.clear()
  movedTabSelections.clear()
  heldTabs.clear()
  redrawListeners.clear()
}
