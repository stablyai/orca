// Test hook on the window's frame apply: `installLayoutFrameApplyCheck` (installed by the frame
// tests) checks after every flush that the store shows what the full build shows for the same
// cache, view and facts. Release and dev builds install none.

import type { AppState } from '@/store/types'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export type LayoutFrameApplyObservation = {
  /** The store before and after the flush. */
  before: AppState
  after: AppState
  cache: WorkspaceLayoutCache
  /** Workspaces whose frames the flush showed. */
  changed: readonly string[]
  /** Of those, the ones built in full and the ones built from the store's view. */
  fullBuilt: readonly string[]
  workspaceBuilt: readonly string[]
  /** The window's own fields each new row took (each intent is taken once). */
  rowFieldsTaken: ReadonlyMap<string, Partial<TerminalTab>>
  /** `state` with the moved tabs selected whose selection the flush wrote with its frame (each
   *  intent is taken once), as the flush selected them. */
  selectTakenMovedTabs: (state: AppState) => AppState
}

type LayoutFrameApplyObserver = (observation: LayoutFrameApplyObservation) => void

let observer: LayoutFrameApplyObserver | null = null

/** Null removes the observer. */
export function observeLayoutFrameApply(next: LayoutFrameApplyObserver | null): void {
  observer = next
}

export function layoutFrameApplyObserver(): LayoutFrameApplyObserver | null {
  return observer
}
