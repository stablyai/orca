import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** In-progress "Send Feedback" report. Session-only (never `persist`-wrapped,
 *  no disk surface): the dialog renders inside the sidebar subtree, which
 *  unmounts whenever the sidebar collapses, and a failed submit is precisely
 *  when the user still needs what they typed (orca#22466). Cleared on a
 *  confirmed delivery or app restart.
 *
 *  Image drafts deliberately stay in the dialog: they hold object URLs and
 *  Uint8Arrays that the unmount cleanup has to revoke, so they cannot outlive
 *  it without leaking the underlying blobs. */
export type FeedbackDraft = {
  feedback: string
  submitAnonymously: boolean
}

export type FeedbackDraftSlice = {
  feedbackDraft: FeedbackDraft
  /** Shallow-merge the patch into the current draft. */
  setFeedbackDraft: (patch: Partial<FeedbackDraft>) => void
  clearFeedbackDraft: () => void
}

// Why a shared constant is safe here (unlike newIssueDraft's factory): every
// field is a primitive, so no caller can mutate one draft into another's state.
const EMPTY_FEEDBACK_DRAFT: FeedbackDraft = { feedback: '', submitAnonymously: false }

export const createFeedbackDraftSlice: StateCreator<AppState, [], [], FeedbackDraftSlice> = (
  set
) => ({
  feedbackDraft: EMPTY_FEEDBACK_DRAFT,
  setFeedbackDraft: (patch) =>
    set((state) => ({ feedbackDraft: { ...state.feedbackDraft, ...patch } })),
  clearFeedbackDraft: () => set({ feedbackDraft: EMPTY_FEEDBACK_DRAFT })
})
