import { shouldPreserveEditableFocus } from '@/components/terminal-pane/pane-helpers'
import { useAppStore } from '@/store'
import { useDialogRegistry } from '@/store/dialog-registry'
import { selectDialogOnScreen } from '@/store/dialog-registry-state'
import { focusRuntimeTerminalSurface } from '@/runtime/sync-runtime-graph'
import type { ActivateAndRevealResult } from '@/lib/worktree-activation'

let cancelPendingFocus: (() => void) | null = null

// A sleeping workspace can publish its tab and mount its terminal after the palette closes.
export function queueWorkspaceActivationTerminalFocus(
  worktreeId: string,
  activation: ActivateAndRevealResult | false
): boolean {
  cancelPendingFocus?.()
  const initial = useAppStore.getState()
  if (
    !activation ||
    initial.activeWorktreeId !== worktreeId ||
    initial.activeView !== 'terminal' ||
    initial.activeTabType !== 'terminal'
  ) {
    return false
  }
  let tabId = activation.primaryTabId ?? initial.activeTabId
  const executionHostId = initial.activeWorkspaceExecutionHostId
  const initialFocus = document.activeElement
  const closingDialog = document.querySelector('[role="dialog"]')
  let frameId: number | null = null
  let finished = false
  const cancel = (): void => {
    if (finished) {
      return
    }
    finished = true
    if (frameId !== null) {
      cancelAnimationFrame(frameId)
    }
    observer.disconnect()
    unsubscribe()
    clearTimeout(timeout)
    document.removeEventListener('pointerdown', cancel, true)
    document.removeEventListener('focusin', onFocus, true)
    if (cancelPendingFocus === cancel) {
      cancelPendingFocus = null
    }
  }
  const attempt = (): void => {
    frameId = null
    const state = useAppStore.getState()
    if (
      state.activeWorktreeId !== worktreeId ||
      state.activeWorkspaceExecutionHostId !== executionHostId ||
      state.activeView !== 'terminal' ||
      state.activeTabType !== 'terminal' ||
      (tabId !== null && state.activeTabId !== tabId)
    ) {
      cancel()
      return
    }
    // The selecting palette can still be finishing its exit animation; keep this action pending.
    if (state.activeModal !== 'none' || selectDialogOnScreen(useDialogRegistry.getState())) {
      return
    }
    tabId ??= state.activeTabId
    if (tabId && focusRuntimeTerminalSurface(tabId, null, worktreeId)) {
      cancel()
    }
  }
  const schedule = (): void => {
    if (!finished && frameId === null) {
      frameId = requestAnimationFrame(attempt)
    }
  }
  const onFocus = (): void => {
    const active = document.activeElement
    if (
      active !== initialFocus &&
      !closingDialog?.contains(active) &&
      shouldPreserveEditableFocus(active)
    ) {
      cancel()
    }
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'data-state']
  })
  const unsubscribe = useAppStore.subscribe(schedule)
  const timeout = setTimeout(cancel, 30_000)
  document.addEventListener('pointerdown', cancel, true)
  document.addEventListener('focusin', onFocus, true)
  cancelPendingFocus = cancel
  schedule()
  return true
}
