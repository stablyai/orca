// Tests install an after-flush store/reference-build observer (installLayoutFrameApplyCheck); release/dev builds install none.

import type { AppState } from '@/store/types'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import type { HeldDrawnTabs } from '@/store/workspace-layout-frame-held-tabs'
import type { TerminalTab } from '../../../shared/terminal-tab-types'

export type LayoutFrameApplyObservation = {
  before: AppState
  after: AppState
  cache: WorkspaceLayoutCache
  changed: readonly string[]
  /** Of those, the ones built in full and the ones built from the store's view. */
  fullBuilt: readonly string[]
  workspaceBuilt: readonly string[]
  /** The window's own fields each new row took (each intent is taken once). */
  rowFieldsTaken: ReadonlyMap<string, Partial<TerminalTab>>
  /** The tabs the flush's builds kept as drawn. */
  held: HeldDrawnTabs
  /** `state` with the moved tabs selected whose selection the flush wrote with its frame (each
   *  intent is taken once), as the flush selected them. */
  selectTakenMovedTabs: (state: AppState) => AppState
}

type LayoutFrameApplyObserver = (observation: LayoutFrameApplyObservation) => void

let observer: LayoutFrameApplyObserver | null = null

export function observeLayoutFrameApply(next: LayoutFrameApplyObserver | null): void {
  observer = next
}

export function layoutFrameApplyObserver(): LayoutFrameApplyObserver | null {
  return observer
}
