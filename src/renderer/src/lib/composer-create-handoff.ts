import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  findPendingLinkedWorkItemCreationId,
  type WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import {
  beginBackgroundWorktreePreparation,
  continueBackgroundWorktreeCreation,
  runBackgroundWorktreeCreation
} from '@/lib/worktree-creation-flow'

// Why: composer preflight (PR fetch, hook checks, settings writes) can stall on
// the network; past this delay the sidebar row owns the submit so the modal closes.
export const COMPOSER_CREATE_HANDOFF_DELAY_MS = 1_500
// Why: the staged row must not become the new place a submit hangs forever.
export const COMPOSER_CREATE_PREPARE_DEADLINE_MS = 5 * 60_000

export type ComposerCreateHandoff = {
  /** Starts creation, continuing the staged sidebar row when one exists. */
  start: (request: WorktreeCreationRequest) => void
  /** True once a staged sidebar row owns the submit. */
  isHandedOff: () => boolean
  /** Reports a handed-off failure; returns false when the composer still owns it. */
  fail: (message: string) => boolean
  /** Ends the handoff window, reporting a handed-off submit that never started. */
  dispose: () => void
}

export function scheduleComposerCreateHandoff({
  stagingRequest,
  onHandOff,
  isCancelled,
  reopenComposer,
  delayMs = COMPOSER_CREATE_HANDOFF_DELAY_MS,
  deadlineMs = COMPOSER_CREATE_PREPARE_DEADLINE_MS
}: {
  /** Display-only placeholder; never executed, so Retry cannot run it. */
  stagingRequest: WorktreeCreationRequest
  onHandOff: () => void
  isCancelled: () => boolean
  /** Restores the user's input once the closed composer can no longer show it. */
  reopenComposer: () => void
  delayMs?: number
  deadlineMs?: number
}): ComposerCreateHandoff {
  let stagedCreationId: string | null = null
  let finished = false
  let deadline: ReturnType<typeof setTimeout> | undefined

  const finish = (): void => {
    finished = true
    clearTimeout(timer)
    clearTimeout(deadline)
  }

  const fail = (message: string): boolean => {
    if (stagedCreationId === null) {
      return false
    }
    if (finished) {
      return true
    }
    finish()
    const store = useAppStore.getState()
    // A missing row means the user cancelled it; stay quiet.
    if (!store.pendingWorktreeCreations[stagedCreationId]) {
      return true
    }
    store.removePendingWorktreeCreation(stagedCreationId)
    toast.error(message, {
      action: {
        label: translate('auto.lib.composerCreateHandoff.reopen', 'Reopen'),
        onClick: reopenComposer
      }
    })
    return true
  }

  const timer = setTimeout(() => {
    if (finished || isCancelled()) {
      return
    }
    stagedCreationId = beginBackgroundWorktreePreparation(stagingRequest)
    onHandOff()
    deadline = setTimeout(
      () =>
        fail(
          translate(
            'auto.lib.composerCreateHandoff.preparationTimedOut',
            'Worktree preparation timed out.'
          )
        ),
      deadlineMs
    )
  }, delayMs)

  return {
    start: (request) => {
      if (finished) {
        return
      }
      finish()
      if (stagedCreationId === null) {
        runBackgroundWorktreeCreation(request)
        return
      }
      const store = useAppStore.getState()
      if (!store.pendingWorktreeCreations[stagedCreationId]) {
        return
      }
      // Why: the staged row could not carry links resolved during preflight, so dedupe now.
      const others = Object.fromEntries(
        Object.entries(store.pendingWorktreeCreations).filter(([id]) => id !== stagedCreationId)
      )
      const existingCreationId = findPendingLinkedWorkItemCreationId(others, request)
      if (existingCreationId) {
        store.removePendingWorktreeCreation(stagedCreationId)
        store.setActivePendingWorktreeCreation(existingCreationId)
        store.setActiveView('terminal')
        store.setSidebarOpen(true)
        return
      }
      continueBackgroundWorktreeCreation(stagedCreationId, request)
    },
    isHandedOff: () => stagedCreationId !== null,
    fail,
    dispose: () => {
      fail(
        translate(
          'auto.lib.composerCreateHandoff.needsInput',
          'Worktree was not created because it needs more input.'
        )
      )
      finish()
    }
  }
}
