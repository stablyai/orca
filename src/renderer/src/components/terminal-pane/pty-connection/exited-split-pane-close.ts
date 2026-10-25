import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import { expectPaneToClose } from '@/runtime/layout-owner-pane-intents'
import { useAppStore } from '@/store'

/** Layout-owner main closes exited panes; wait for its frame. Paired-server ownership returns false for caller-managed close. */
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
