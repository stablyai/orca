import { create } from 'zustand'
import type { CloseTerminalDialogCopyKind } from '@/components/terminal-pane/layout/close/CloseTerminalDialog'

/** A pending confirmation for closing a terminal tab whose shell still has a
 *  running child process. `onConfirm` performs the original close. */
export type RunningTerminalCloseConfirmRequest = {
  terminalTabId: string
  copyKind: CloseTerminalDialogCopyKind
  /** The tab's workspace, named in the title. */
  worktreeId?: string
  /** Sleeping this workspace keeps the busy agents resumable, so it is offered instead. */
  canSleepInstead?: boolean
  /** An idle recheck's async probe opens this prompt after its callback returned; guard it on show. */
  guardWhenVisible?: boolean
  onConfirm: () => void
  onCancel?: () => void
}

export type RunningTerminalCloseConfirmState = {
  runningTerminalCloseConfirm: RunningTerminalCloseConfirmRequest | null
  requestRunningTerminalCloseConfirm: (request: RunningTerminalCloseConfirmRequest) => void
  confirmRunningTerminalClose: () => void
  /** Opting out accepts visible and queued running-work requests; idle prompts stay queued. */
  confirmAllRunningTerminalCloses: () => void
  dismissRunningTerminalClose: () => boolean
}

function isIdleCopyKind(copyKind: CloseTerminalDialogCopyKind): boolean {
  return copyKind === 'idle' || copyKind === 'idle-chat'
}

/** Merge duplicate tab requests so both initiating surfaces receive callbacks. */
function mergeRequests(
  pending: RunningTerminalCloseConfirmRequest,
  duplicate: RunningTerminalCloseConfirmRequest
): RunningTerminalCloseConfirmRequest {
  // An idle prompt vouches for nothing that is running; a merged running close must own the copy.
  const runningConsentFirst =
    isIdleCopyKind(pending.copyKind) && !isIdleCopyKind(duplicate.copyKind)
  const [first, second] = runningConsentFirst ? [duplicate, pending] : [pending, duplicate]
  return {
    ...pending,
    // The running request owns the upgraded prompt, including its workspace and sleep offer.
    ...(runningConsentFirst
      ? {
          copyKind: duplicate.copyKind,
          ...(duplicate.worktreeId ? { worktreeId: duplicate.worktreeId } : {}),
          ...(duplicate.canSleepInstead ? { canSleepInstead: duplicate.canSleepInstead } : {})
        }
      : {}),
    // Run consented running work first so the idle re-check sees a closed tab instead of asking again.
    onConfirm: () => {
      first.onConfirm()
      second.onConfirm()
    },
    onCancel: () => {
      pending.onCancel?.()
      duplicate.onCancel?.()
    }
  }
}

// Keep dialog-only state outside AppState: closeTerminalTab fixtures use partial stores and cannot safely dispatch through the app singleton.
export const useRunningTerminalCloseConfirmStore = create<RunningTerminalCloseConfirmState>()((
  set,
  get
) => {
  const queuedRequests: RunningTerminalCloseConfirmRequest[] = []
  // Guard dialog replacement against held Enter/double-click closing an unseen second tab, like pin confirmation.
  const INTER_REQUEST_ACTION_GUARD_MS = 350
  let nextRequestActionAllowedAt = 0
  // A prompt opened from onConfirm replaces the confirmed one while the dialog stays mounted.
  let confirmCallbackRunning = false

  /** Reveals the next queued request, and reports whether one took the visible slot. */
  const advanceRequest = (): boolean => {
    const next = queuedRequests.shift() ?? null
    set({ runningTerminalCloseConfirm: next })
    return next !== null
  }

  const guardNextAction = (revealedNextRequest: boolean): void => {
    nextRequestActionAllowedAt = revealedNextRequest
      ? Date.now() + INTER_REQUEST_ACTION_GUARD_MS
      : 0
  }

  return {
    runningTerminalCloseConfirm: null,

    requestRunningTerminalCloseConfirm: (request) => {
      const visible = get().runningTerminalCloseConfirm
      // Async process probes allow duplicate clicks before opening; share one prompt while resolving both closes.
      if (visible?.terminalTabId === request.terminalTabId) {
        const merged = mergeRequests(visible, request)
        set({ runningTerminalCloseConfirm: merged })
        // An in-place upgrade rewrites the copy under a held key/click; guard it like a revealed prompt.
        if (isIdleCopyKind(visible.copyKind) && !isIdleCopyKind(merged.copyKind)) {
          guardNextAction(true)
        }
        return
      }
      const queuedIndex = queuedRequests.findIndex(
        (queued) => queued.terminalTabId === request.terminalTabId
      )
      if (queuedIndex !== -1) {
        queuedRequests[queuedIndex] = mergeRequests(queuedRequests[queuedIndex]!, request)
        return
      }
      if (visible) {
        // Queue rapid busy-tab closes or replacing the request strands its callback.
        queuedRequests.push(request)
        return
      }
      set({ runningTerminalCloseConfirm: request })
      // The key or click aimed at the confirmed prompt must not accept its in-place replacement;
      // an idle recheck declares its prompt so the guard outlives the callback that scheduled it.
      if (confirmCallbackRunning || request.guardWhenVisible === true) {
        guardNextAction(true)
      }
    },

    confirmRunningTerminalClose: () => {
      const request = get().runningTerminalCloseConfirm
      if (!request || Date.now() < nextRequestActionAllowedAt) {
        return
      }
      // Advance before onConfirm so reentrant closes cannot see the stale request.
      guardNextAction(advanceRequest())
      confirmCallbackRunning = true
      try {
        request.onConfirm()
      } finally {
        confirmCallbackRunning = false
      }
    },

    confirmAllRunningTerminalCloses: () => {
      if (Date.now() < nextRequestActionAllowedAt) {
        return
      }
      const pending = [get().runningTerminalCloseConfirm, ...queuedRequests.splice(0)].filter(
        (request): request is RunningTerminalCloseConfirmRequest => request !== null
      )
      // Why: the opt-out covers running work; an idle prompt is a separate opt-in and must still ask.
      const idle = pending.filter((request) => isIdleCopyKind(request.copyKind))
      const running = pending.filter((request) => !isIdleCopyKind(request.copyKind))
      set({ runningTerminalCloseConfirm: idle[0] ?? null })
      if (idle.length > 1) {
        queuedRequests.push(...idle.slice(1))
      }
      // A revealed idle prompt is a new dialog action target; arm the same inter-request guard.
      guardNextAction(idle.length > 0)
      for (const request of running) {
        request.onConfirm()
      }
    },

    dismissRunningTerminalClose: () => {
      const request = get().runningTerminalCloseConfirm
      if (!request || Date.now() < nextRequestActionAllowedAt) {
        return false
      }
      guardNextAction(advanceRequest())
      // Why: callers such as the tab-group model resume their own cleanup on cancel.
      request.onCancel?.()
      return true
    }
  }
})
