import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { expectPaneToClose } from '@/runtime/layout-owner-pane-intents'
import { useAppStore } from '@/store'

/**
 * A split pane whose terminal ended, in a layout-owner build: main saw the exit and closes the
 * pane by the same rule, so the window only expects main's frame to drop it. False when a paired
 * server owns the workspace; the caller closes as today.
 */
export function expectExitedSplitPaneClose(pane: {
  worktreeId: string
  tabId: string
  leafId: string | null
}): boolean {
  if (
    !pane.leafId ||
    runtimeEnvironmentIdUnlessTwin(useAppStore.getState(), pane.worktreeId) !== null
  ) {
    return false
  }
  expectPaneToClose(pane.tabId, pane.leafId, 'exit')
  return true
}
