import { runtimeEnvironmentIdUnlessTwin } from '@/lib/workspace/ownership/resolve-owner'
import { expectPaneToClose } from '@/runtime/workspace-layout/intents/layout-owner-pane-intents'
import { useAppStore } from '@/store/index'

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
