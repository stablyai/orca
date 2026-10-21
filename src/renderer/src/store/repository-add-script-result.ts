import { create } from 'zustand'

/** The terminal outcomes that need more than a toast; `succeeded` and quiet statuses do not. */
export type RepositoryAddScriptResultView = {
  status: 'failed' | 'unverifiable'
  path: string
  hostLabel: string
  // Absent when no exit was observed; never substitute a number.
  exitCode?: number
  output: string
  outputTruncated: boolean
  reason?: 'execution-failed'
}

// Why: the footer button does not move between results, so a double click or held Enter would
// otherwise consume the next unread result along with the one it was aimed at.
const INTER_RESULT_DISMISS_GUARD_MS = 350

export type RepositoryAddScriptResultState = {
  result: RepositoryAddScriptResultView | null
  /** Results that finished while another was on screen; shown in arrival order. */
  queued: readonly RepositoryAddScriptResultView[]
  /** In state so a test (or a remount) can reset it without reaching into module scope. */
  dismissAllowedAt: number
  showRepositoryAddScriptResult: (result: RepositoryAddScriptResultView) => void
  dismissRepositoryAddScriptResult: () => void
}

export const useRepositoryAddScriptResultStore = create<RepositoryAddScriptResultState>()(
  (set) => ({
    result: null,
    queued: [],
    dismissAllowedAt: 0,
    // Why: two scripts can finish together, and the second must not overwrite an unread result.
    showRepositoryAddScriptResult: (result) =>
      set((state) => (state.result === null ? { result } : { queued: [...state.queued, result] })),
    dismissRepositoryAddScriptResult: () =>
      set((state) => {
        if (state.result === null || Date.now() < state.dismissAllowedAt) {
          return state
        }
        const [next, ...rest] = state.queued
        return {
          result: next ?? null,
          queued: rest,
          dismissAllowedAt: Date.now() + INTER_RESULT_DISMISS_GUARD_MS
        }
      })
  })
)
