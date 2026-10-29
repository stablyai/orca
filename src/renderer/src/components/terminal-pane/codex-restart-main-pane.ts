// Main-owned restarts require an existing main pane and use its frame binding; the window must not invent a tree.
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'
import type { AppState } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

/** Window binds when ownership is local/paired fallback; held means main knows the pane, missing prevents restart. */
export function restartPaneOwner(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string
): 'window' | 'held' | 'missing' {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || runtimeEnvironmentIdUnlessTwin(state, worktreeId) !== null) {
    return 'window'
  }
  const panes = layoutFrameTerminalTab(worktreeId, tabId)?.terminal?.panes ?? []
  return panes.some((pane) => pane.leafId === leafId) ? 'held' : 'missing'
}
