// Expose main-framed terminal ownership without importing frame sync into window-owned builds.

import type { PublishedTab } from '../../../shared/workspace-layout/workspace-layout-published'

type TerminalPane = { tabId: string; leafId: string; ptyId: string }

export type LayoutFrameTerminalQueries = {
  /** Whether main's latest frames show this terminal in this pane, drawn yet or not. An unbound
   *  pane does not count: nothing binds a frame-drawn pane to a live terminal later. */
  holdsTerminalPane: (worktreeId: string, pane: TerminalPane) => boolean
  /** Main's terminal tab with this terminal id in its latest frames, drawn yet or not. */
  terminalTab: (worktreeId: string, tabId: string) => PublishedTab | undefined
}

let queries: LayoutFrameTerminalQueries | null = null

/** Set by the window's layout stream once it opens. */
export function provideLayoutFrameTerminalPanes(next: LayoutFrameTerminalQueries): void {
  queries = next
}

/** Whether main's frames will draw this terminal's pane; false before the window's stream opens. */
export function layoutFramesHoldTerminalPane(worktreeId: string, pane: TerminalPane): boolean {
  return queries?.holdsTerminalPane(worktreeId, pane) ?? false
}

/** The terminal tab main already holds under this id; undefined before the window's stream opens. */
export function layoutFrameTerminalTab(
  worktreeId: string,
  tabId: string
): PublishedTab | undefined {
  return queries?.terminalTab(worktreeId, tabId)
}
