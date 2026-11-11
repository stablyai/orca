import { useAppStore } from '@/store/index'
import { resolveActiveTabOwnerWorktreeId } from '@/store/terminals/active-tab-owner-worktree'
import { FOCUS_TERMINAL_PANE_EVENT, type FocusTerminalPaneDetail } from '@/constants/terminal'
import type { AppState } from '@/store/types'

let pendingFocusPaneFrameId: number | null = null
let disposePendingFocusFence: (() => void) | null = null

function focusSelection(state: AppState): string {
  const worktreeId = state.activeWorktreeId
  return JSON.stringify([
    worktreeId,
    state.activeWorkspaceExecutionHostId,
    state.activeTabId,
    state.activeTabType,
    worktreeId ? state.activeGroupIdByWorktree[worktreeId] : null,
    worktreeId ? state.activeTabTypeByWorktree[worktreeId] : null,
    state.activeTabId ? state.terminalLayoutsByTabId[state.activeTabId]?.activeLeafId : null
  ])
}

function cancelPendingFocusPaneFrame(): void {
  disposePendingFocusFence?.()
  disposePendingFocusFence = null
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
    collapseExpandedPane?: boolean
    /** Async creation must not focus after a later user selection during the mount frame. */
    canFocus?: () => boolean
  }
): void {
  const { setActiveTab, setActiveTabType, tabsByWorktree, activeWorktreeId } =
    useAppStore.getState()
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
  let selectionUnchanged = true
  if (opts?.canFocus) {
    const initial = focusSelection(useAppStore.getState())
    disposePendingFocusFence = useAppStore.subscribe((state) => {
      if (focusSelection(state) !== initial) {
        selectionUnchanged = false
      }
    })
  }
  // Wait one frame for the new TerminalPane’s focus-event listener to mount.
  pendingFocusPaneFrameId = requestAnimationFrame(() => {
    pendingFocusPaneFrameId = null
    disposePendingFocusFence?.()
    disposePendingFocusFence = null
    if (!selectionUnchanged || opts?.canFocus?.() === false) {
      return
    }
    const detail: FocusTerminalPaneDetail = {
      tabId,
      leafId,
      ...(opts?.ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess: opts.ackPaneKeyOnSuccess } : {}),
      ...(opts?.flashFocusedPane ? { flashFocusedPane: true } : {}),
      ...(opts?.scrollToBottomIfOutputSinceLastView
        ? { scrollToBottomIfOutputSinceLastView: true }
        : {}),
      ...(opts?.collapseExpandedPane ? { collapseExpandedPane: true } : {})
    }
    window.dispatchEvent(
      new CustomEvent<FocusTerminalPaneDetail>(FOCUS_TERMINAL_PANE_EVENT, {
        detail
      })
    )
  })
}
