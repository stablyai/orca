import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { useRunningTerminalCloseConfirmStore } from '@/store/running-terminal-close-confirm'
import {
  isFloatingWorkspacePopoutDetached,
  isFloatingWorkspaceTerminalTab,
  subscribeFloatingWorkspacePopoutDetached
} from '@/components/floating-terminal/floating-workspace-popout-shared-state'
import CloseTerminalDialog from './CloseTerminalDialog'

/** Hosts the running-process close confirmation for tab-level closes (tab-strip X,
 *  middle-click, tab menu, tab groups, floating panel) so they share the prompt Cmd+W
 *  already raised. Store-driven, like PinnedTabCloseDialog, because those closes run
 *  outside any pane's React tree. */
export default function RunningTerminalCloseDialog({
  scope = 'main'
}: {
  // Why popout: the App host lives in the main document, so a floating-originated
  // request while detached renders in the popout host instead — same store, one modal.
  scope?: 'main' | 'popout'
}): React.JSX.Element | null {
  const request = useRunningTerminalCloseConfirmStore((state) => state.runningTerminalCloseConfirm)
  const confirmClose = useRunningTerminalCloseConfirmStore(
    (state) => state.confirmRunningTerminalClose
  )
  const confirmAllCloses = useRunningTerminalCloseConfirmStore(
    (state) => state.confirmAllRunningTerminalCloses
  )
  const dismissClose = useRunningTerminalCloseConfirmStore(
    (state) => state.dismissRunningTerminalClose
  )
  const updateSettings = useAppStore((state) => state.updateSettings)
  // Why: this queue is async (it opens after a probe) while the pinned queue is synchronous,
  // so both can be pending at once. Wait rather than stack two modal overlays and focus traps.
  const pinnedRequest = useAppStore((state) => state.pinnedTabCloseConfirm)
  const popoutDetached = useSyncExternalStore(
    subscribeFloatingWorkspacePopoutDetached,
    isFloatingWorkspacePopoutDetached
  )
  const floatingOrigin = request ? isFloatingWorkspaceTerminalTab(request.terminalTabId) : false
  if (scope === 'popout' ? !(popoutDetached && floatingOrigin) : popoutDetached && floatingOrigin) {
    return null
  }
  return (
    <CloseTerminalDialog
      open={request !== null && pinnedRequest === null}
      copyKind={request?.copyKind ?? 'command'}
      {...(request?.tabLabel ? { tabLabel: request.tabLabel } : {})}
      // Why: a queued request swaps tabs in the already-open dialog, so the reopen reset
      // never runs; naming the subject is what clears the previous tab's opt-out tick.
      {...(request ? { subjectKey: request.terminalTabId } : {})}
      onCancel={dismissClose}
      onConfirm={(dontAskAgain) => {
        if (dontAskAgain) {
          void updateSettings({ skipCloseTerminalWithRunningProcessConfirm: true })
          // Why: the user just opted out of this prompt; a queued one must not still appear.
          confirmAllCloses()
          return
        }
        confirmClose()
      }}
    />
  )
}
