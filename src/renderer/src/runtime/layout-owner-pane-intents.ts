// What this window asked main to do to a tab's panes, in a layout-owner build: main's frames say
// which panes a tab has, these say what the window wants done when one appears or goes (its
// spawn inputs, its close) and keep a tab's drawn tree while the window's own command is in
// flight. A pane a frame adds or drops with no intent here is left to main's notice to the window.

import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalPaneSplitSource } from '../../../shared/feature-education-telemetry'

export type PaneAppearIntent = {
  tabId: string
  cwd?: string
  cwdPromise?: Promise<string>
  telemetry: { source: TerminalPaneSplitSource; direction: 'vertical' | 'horizontal' }
}

/** Intents outlive their frame only when a tab never mounts again; keep the newest few. */
const MAX_INTENTS = 64

const appearing = new Map<string, PaneAppearIntent>()
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

export function expectPaneToAppear(leafId: string, intent: PaneAppearIntent): () => void {
  remember(appearing, leafId, intent)
  return () => {
    if (appearing.get(leafId) === intent) {
      appearing.delete(leafId)
    }
  }
}

export function takePaneAppearIntent(tabId: string, leafId: string): PaneAppearIntent | null {
  const intent = appearing.get(leafId)
  if (intent?.tabId !== tabId) {
    return null
  }
  appearing.delete(leafId)
  return intent
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
  appearing.clear()
  closing.clear()
  rowFields.clear()
  heldTabs.clear()
  redrawListeners.clear()
}
