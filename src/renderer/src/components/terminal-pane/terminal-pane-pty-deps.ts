import { settlePaneCwdDeferredSpawn } from './resolve-split-cwd'
import {
  clearDeferredSplitPaneHandoff,
  type DeferredSplitPaneHandoffHandle
} from './deferred-split-pane-handoff'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'

/** Builds the mutable PTY dependency bag shared by every pane in one mount. */
export function createTerminalPanePtyDeps(args: {
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  startupCwd: string
  startupWithSetupSplitWait: PtyConnectionDeps['startup']
  mountFollowsTerminalPark: boolean
  restoredPtyIdByLeafId: Record<string, string>
  deferredSplitHandoffs: Map<number, DeferredSplitPaneHandoffHandle>
}): PtyConnectionDeps {
  const {
    deps,
    refs,
    startupCwd,
    startupWithSetupSplitWait,
    mountFollowsTerminalPark,
    deferredSplitHandoffs
  } = args
  // A concrete PTY owns the input queue and settles the split admission fence,
  // so the deferred lookup stops being reusable. Both layout-binding variants
  // must run this: main routes live binds through the leaf-keyed one.
  const settleDeferredSplitOnBind = (paneId: number, ptyId: string | null): void => {
    if (!ptyId) {
      return
    }
    const deferredSplitHandoff = deferredSplitHandoffs.get(paneId)
    if (deferredSplitHandoff) {
      clearDeferredSplitPaneHandoff(deferredSplitHandoff)
      deferredSplitHandoffs.delete(paneId)
    }
    settlePaneCwdDeferredSpawn(deps.paneCwdRef.current, paneId)
  }
  return {
    tabId: deps.tabId,
    worktreeId: deps.worktreeId,
    cwd: startupCwd,
    startup: startupWithSetupSplitWait,
    mountFollowsTerminalPark,
    paneTransportsRef: deps.paneTransportsRef,
    paneMode2031Ref: deps.paneMode2031Ref,
    paneKittyKeyboardModesRef: deps.paneKittyKeyboardModesRef,
    paneLastThemeModeRef: deps.paneLastThemeModeRef,
    replayingPanesRef: deps.replayingPanesRef,
    restoredViewportBlankingPanesRef: refs.restoredViewportBlankingPanesRef,
    isActiveRef: deps.isActiveRef,
    isVisibleRef: deps.isVisibleRef,
    onPtyExitRef: deps.onPtyExitRef,
    onAgentExitedRef: deps.onAgentExitedRef,
    onPtyErrorRef: deps.onPtyErrorRef,
    onPtyErrorClearedRef: deps.onPtyErrorClearedRef,
    onPaneProcessDied: deps.onPaneProcessDied,
    onPtyRecoveryStateRef: deps.onPtyRecoveryStateRef,
    clearTabPtyId: deps.clearTabPtyId,
    consumeSuppressedPtyExit: deps.consumeSuppressedPtyExit,
    isPtyShutdownPending: deps.isPtyShutdownPending,
    updateTabTitle: deps.updateTabTitle,
    setRuntimePaneTitle: deps.setRuntimePaneTitle,
    clearRuntimePaneTitle: deps.clearRuntimePaneTitle,
    updateTabPtyId: deps.updateTabPtyId,
    markWorktreeUnread: deps.markWorktreeUnread,
    markTerminalTabUnread: deps.markTerminalTabUnread,
    markTerminalPaneUnread: deps.markTerminalPaneUnread,
    clearWorktreeUnread: deps.clearWorktreeUnread,
    clearTerminalTabUnread: deps.clearTerminalTabUnread,
    clearTerminalPaneUnread: deps.clearTerminalPaneUnread,
    onShowSessionRestoredBanner: deps.onShowSessionRestoredBanner,
    dispatchNotification: deps.dispatchNotification,
    setCacheTimerStartedAt: deps.setCacheTimerStartedAt,
    syncPanePtyLayoutBinding: (paneId: number, ptyId: string | null) => {
      settleDeferredSplitOnBind(paneId, ptyId)
      deps.syncPanePtyLayoutBinding(paneId, ptyId)
    },
    ...(deps.syncPanePtyLayoutBindingForLeaf
      ? {
          syncPanePtyLayoutBindingForLeaf: (
            leafId: string,
            ptyId: string | null,
            sourcePaneId: number
          ) => {
            settleDeferredSplitOnBind(sourcePaneId, ptyId)
            deps.syncPanePtyLayoutBindingForLeaf?.(leafId, ptyId, sourcePaneId)
          }
        }
      : {}),
    clearExitedPanePtyLayoutBinding: deps.clearExitedPanePtyLayoutBinding,
    clearExitedPanePtyLayoutBindingForLeaf: deps.clearExitedPanePtyLayoutBindingForLeaf,
    onStartupBound: deps.onStartupBound,
    deferPtyInput: (paneId, data, forward) => {
      const suppression =
        refs.httpLinkClickFallbackDisposablesRef.current.get(paneId)?.ptyMouseSuppression
      if (suppression) {
        suppression.handlePtyInput(data, forward)
      } else {
        forward(data)
      }
    },
    recordPaneMode2031Subscription: (paneId, mode) => {
      deps.paneMode2031Ref.current.set(paneId, true)
      deps.paneLastThemeModeRef.current.set(paneId, mode)
    },
    restoredPtyIdByLeafId: args.restoredPtyIdByLeafId
  }
}
