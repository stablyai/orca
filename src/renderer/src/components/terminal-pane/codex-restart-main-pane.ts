// Layout-owner build: an account-switch restart binds only into a pane main's layout holds, and
// main's frame draws the new binding; the window writes no pane tree of its own (ledger L197).
import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { layoutFrameTerminalTab } from '@/runtime/layout-frame-terminal-panes'
import type { AppState } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

/**
 * 'window': the window binds the restart as before (switch off, or a paired server's workspace).
 * 'held': main's layout holds the pane. 'missing': it does not, so the restart is not started.
 */
export function restartPaneOwner(
  state: AppState,
  worktreeId: string,
  tabId: string,
  leafId: string
): 'window' | 'held' | 'missing' {
  // Switch point: main's layout is the one record of which panes a tab has.
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || runtimeEnvironmentIdUnlessTwin(state, worktreeId) !== null) {
    return 'window'
  }
  const panes = layoutFrameTerminalTab(worktreeId, tabId)?.terminal?.panes ?? []
  return panes.some((pane) => pane.leafId === leafId) ? 'held' : 'missing'
}
