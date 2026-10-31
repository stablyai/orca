import { useAppStore } from '@/store'
import { navigateDesktopTab } from './desktop-navigation'
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
  const owner = resolveActiveTabOwnerWorktreeId(tabsByWorktree, activeWorktreeId, tabId)
  const target = owner
    ? useAppStore
        .getState()
        .unifiedTabsByWorktree[owner]?.find(
          (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
        )
    : undefined
  if (target) {
    navigateDesktopTab(target.id, { worktreeId: target.worktreeId })
  }
  // Reveal Terminal for tab-only activation, scoped to its owner so a late reveal cannot change another workspace’s surface.
  setActiveTabType(
    'terminal',
    resolveActiveTabOwnerWorktreeId(tabsByWorktree, activeWorktreeId, tabId) ?? activeWorktreeId
  )
  setActiveTab(tabId)
  cancelPendingFocusPaneFrame()
  if (leafId === null) {
    return
  }
  // Wait one frame for the new TerminalPane’s focus-event listener to mount.
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
