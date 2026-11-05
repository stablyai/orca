import { useStore } from 'zustand'
import type { AppState } from '@/store/types'
import { createFeedbackDraftSlice } from '@/store/slices/feedback-draft'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'

const feedbackStore = createUIStore()
feedbackStore.setState(
  createFeedbackDraftSlice(feedbackStore.setState, feedbackStore.getState, feedbackStore)
)

export const useAppStore = Object.assign(
  <T>(selector: (state: AppState) => T): T => useStore(feedbackStore, selector),
  feedbackStore
)
