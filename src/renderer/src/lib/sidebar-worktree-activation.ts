import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { markInputQuietSchedulerInput, scheduleAfterInputQuiet } from '@/lib/input-quiet-scheduler'

const SLEPT_WORKTREE_ACTIVATION_INPUT_QUIET_MS = 450
const SLEPT_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS = 120

let pendingSidebarWorktreeActivation: {
  worktreeId: string
  cancel: () => void
} | null = null

export function cancelPendingSidebarWorktreeActivation(): void {
  pendingSidebarWorktreeActivation?.cancel()
  pendingSidebarWorktreeActivation = null
}

function shouldDeferSidebarWorktreeActivation(worktreeId: string): boolean {
  // Why: web clients should activate immediately to avoid host/session churn and wake lag.
  if ((globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true) {
    return false
  }
  const state = useAppStore.getState()
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  if (tabs.length === 0) {
    return false
  }
  if ((state.browserTabsByWorktree[worktreeId] ?? []).length > 0) {
    return false
  }
  if (state.openFiles.some((file) => file.worktreeId === worktreeId)) {
    return false
  }
  return tabs.every((tab) => !tabHasLivePty(state.ptyIdsByTabId, tab.id))
}

export function activateWorktreeFromSidebar(worktreeId: string): void {
  cancelPendingSidebarWorktreeActivation()

  const activate = (): void => {
    if (pendingSidebarWorktreeActivation?.worktreeId === worktreeId) {
      pendingSidebarWorktreeActivation = null
    }
    activateAndRevealWorktree(worktreeId)
  }

  if (!shouldDeferSidebarWorktreeActivation(worktreeId)) {
    activate()
    return
  }

  markInputQuietSchedulerInput()
  // Why: a slept workspace may remount terminals. Keep that work cancellable so
  // a quick "changed my mind" click is never queued behind the first wake.
  pendingSidebarWorktreeActivation = {
    worktreeId,
    cancel: scheduleAfterInputQuiet(activate, {
      delayMs: 0,
      quietMs: SLEPT_WORKTREE_ACTIVATION_INPUT_QUIET_MS,
      idleTimeoutMs: SLEPT_WORKTREE_ACTIVATION_IDLE_TIMEOUT_MS
    })
  }
}
