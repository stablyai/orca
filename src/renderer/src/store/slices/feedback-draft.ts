import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** Keep text feedback in session memory across sidebar/dialog unmount and failed submits (#22466); clear on delivery/restart. Images remain dialog-owned because unmount must revoke object URLs/blob buffers. */
export type FeedbackDraft = {
  feedback: string
  submitAnonymously: boolean
}

export type FeedbackDraftSlice = {
  feedbackDraft: FeedbackDraft
  setFeedbackDraft: (patch: Partial<FeedbackDraft>) => void
  clearFeedbackDraft: () => void
}

// All fields are primitives, so sharing defaults cannot mutate another draft.
const EMPTY_FEEDBACK_DRAFT: FeedbackDraft = { feedback: '', submitAnonymously: false }

export const createFeedbackDraftSlice: StateCreator<AppState, [], [], FeedbackDraftSlice> = (
  set
) => ({
  feedbackDraft: EMPTY_FEEDBACK_DRAFT,
  setFeedbackDraft: (patch) =>
    set((state) => ({ feedbackDraft: { ...state.feedbackDraft, ...patch } })),
  clearFeedbackDraft: () => set({ feedbackDraft: EMPTY_FEEDBACK_DRAFT })
})
