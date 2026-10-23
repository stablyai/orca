// Which workspaces main's layout frames draw in the window, when the window starts holding one,
// and which terminal panes a frame shows.

import type { AppState } from '@/store/types'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import { pairedServerMirrors } from './paired-server-workspace'

type HeldWorkspacesStore = {
  getState: () => AppState
  subscribe: (listener: (state: AppState) => void) => () => void
}

/** Which workspaces frames draw: ones the window holds that no paired server mirrors. */
export function framesDrawWorkspace(state: AppState): (key: string) => boolean {
  const mirrored = pairedServerMirrors(state)
  return (key) =>
    (key in state.groupsByWorktree || key in state.unifiedTabsByWorktree) && !mirrored(key)
}

/**
 * Calls `onDrawn` when frames start drawing one of `unshown` (main's workspaces the window does not
 * show): the window's first visit to a workspace only main held, after which no frame need follow.
 */
export function onWorkspaceStartsDrawing(
  store: HeldWorkspacesStore,
  draws: (state: AppState) => (key: string) => boolean,
  unshown: () => string[],
  onDrawn: () => void
): () => void {
  let held = store.getState()
  return store.subscribe((state) => {
    if (
      state.groupsByWorktree === held.groupsByWorktree &&
      state.unifiedTabsByWorktree === held.unifiedTabsByWorktree
    ) {
      return
    }
    held = state
    if (unshown().some(draws(state))) {
      onDrawn()
    }
  })
}

/** Whether a frame shows this terminal in this pane. An unbound pane does not count. */
export function layoutHoldsBoundPane(
  layout: PublishedWorkspaceLayout | undefined,
  { tabId, leafId, ptyId }: { tabId: string; leafId: string; ptyId: string }
): boolean {
  return (
    layout?.tabs.some(
      (tab) =>
        tab.entityId === tabId &&
        (tab.terminal?.panes.some((pane) => pane.leafId === leafId && pane.ptyId === ptyId) ??
          false)
    ) ?? false
  )
}
