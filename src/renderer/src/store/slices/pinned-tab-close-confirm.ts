import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** A pending request to confirm closing a pinned tab. `onConfirm` runs the
 *  original close once the user accepts; the label is shown in the dialog. */
export type PinnedTabCloseConfirmRequest = {
  tabLabel: string
  onConfirm: () => void
  onCancel?: () => void
}

export type PinnedTabCloseConfirmSlice = {
  pinnedTabCloseConfirm: PinnedTabCloseConfirmRequest | null
  requestPinnedTabCloseConfirm: (request: PinnedTabCloseConfirmRequest) => void
  confirmPinnedTabClose: () => void
  dismissPinnedTabClose: () => void
}

export const createPinnedTabCloseConfirmSlice: StateCreator<
  AppState,
  [],
  [],
  PinnedTabCloseConfirmSlice
> = (set, get) => {
  const queuedRequests: PinnedTabCloseConfirmRequest[] = []
  let nextRequestActionAllowedAt = 0
  const INTER_REQUEST_ACTION_GUARD_MS = 350

  const advanceRequest = (): boolean => {
    const next = queuedRequests.shift() ?? null
    set({ pinnedTabCloseConfirm: next })
    return next !== null
  }

  return {
    pinnedTabCloseConfirm: null,

    requestPinnedTabCloseConfirm: (request) => {
      if (get().pinnedTabCloseConfirm) {
        // Why: autonomous PTY exits can request multiple confirmations in one
        // tick. Queue them so replacing the visible request cannot strand the
        // first tab's close cleanup and buffered exit state.
        queuedRequests.push(request)
        return
      }
      set({ pinnedTabCloseConfirm: request })
    },

    confirmPinnedTabClose: () => {
      if (Date.now() < nextRequestActionAllowedAt) {
        return
      }
      const request = get().pinnedTabCloseConfirm
      if (!request) {
        return
      }
      // Why: advance before running onConfirm so a re-entrant close queues
      // behind the next real request instead of seeing the stale one.
      if (advanceRequest()) {
        nextRequestActionAllowedAt = Date.now() + INTER_REQUEST_ACTION_GUARD_MS
      }
      request.onConfirm()
    },

    dismissPinnedTabClose: () => {
      if (Date.now() < nextRequestActionAllowedAt) {
        return
      }
      const request = get().pinnedTabCloseConfirm
      if (!request) {
        return
      }
      // Why: CLI close requests wait for a response even when the user cancels.
      if (advanceRequest()) {
        nextRequestActionAllowedAt = Date.now() + INTER_REQUEST_ACTION_GUARD_MS
      }
      request.onCancel?.()
    }
  }
}
