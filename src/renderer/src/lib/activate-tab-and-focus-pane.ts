import { useAppStore } from '@/store'
import { resolveActiveTabOwnerWorktreeId } from '@/store/slices/active-tab-owner-worktree'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'

let pendingFocusPaneFrameId: number | null = null

function cancelPendingFocusPaneFrame(): void {
  if (pendingFocusPaneFrameId !== null) {
    cancelAnimationFrame(pendingFocusPaneFrameId)
    pendingFocusPaneFrameId = null
  }
}

export function activateTabAndFocusPane(
  tabId: string,
  leafId: string | null,
  opts?: {
    ackPaneKeyOnSuccess?: string
    flashFocusedPane?: boolean
    scrollToBottomIfOutputSinceLastView?: boolean
  }
): void {
  const { setActiveTab, setActiveTabType, tabsByWorktree, activeWorktreeId } =
    useAppStore.getState()
  // Why: selecting a terminal tab is independent from the visible surface;
  // force Terminal first so tab-only activation reveals the full log.
  // Scoped to the tab's owner: a reveal that lands after a worktree switch must not retype another worktree.
  // An id no worktree owns yet keeps the on-screen worktree, as before scoping.
  setActiveTabType(
    'terminal',
    resolveActiveTabOwnerWorktreeId(tabsByWorktree, activeWorktreeId, tabId) ?? activeWorktreeId
  )
  setActiveTab(tabId)
  cancelPendingFocusPaneFrame()
  if (leafId === null) {
    return
  }
  // Why: defer one frame so the new TerminalPane has mounted its
  // FOCUS_TERMINAL_PANE_EVENT listener before we dispatch.
  pendingFocusPaneFrameId = requestAnimationFrame(() => {
    pendingFocusPaneFrameId = null
    const detail: FocusTerminalPaneDetail = {
      tabId,
      leafId,
      ...(opts?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: opts.ackPaneKeyOnSuccess } : {}),
      ...(opts?.flashFocusedPane ? { flashFocusedPane: true } : {}),
      ...(opts?.scrollToBottomIfOutputSinceLastView
        ? { scrollToBottomIfOutputSinceLastView: true }
        : {})
    }
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, {
        detail
      })
    )
  })
}
