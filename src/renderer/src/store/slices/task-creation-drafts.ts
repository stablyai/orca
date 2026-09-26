import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** Session-only text drafts for Linear/Jira/Businessmap creation dialogs; picker selections stay fresh. */
export type NewLinearIssueDraft = { title: string; body: string }
export type NewLinearProjectDraft = { name: string; description: string; content: string }
export type NewJiraIssueDraft = { title: string; body: string }
export type NewBusinessmapCardDraft = { title: string; body: string }

/** Empty forms do not replace a later open with a meaningless draft. */
export function isTaskCreationDraftContentful(fields: Record<string, string>): boolean {
  return Object.values(fields).some((value) => value.trim().length > 0)
}

export type TaskCreationDraftsSlice = {
  newLinearIssueDraft: NewLinearIssueDraft | null
  setNewLinearIssueDraft: (draft: NewLinearIssueDraft) => void
  clearNewLinearIssueDraft: () => void
  newLinearProjectDraft: NewLinearProjectDraft | null
  setNewLinearProjectDraft: (draft: NewLinearProjectDraft) => void
  clearNewLinearProjectDraft: () => void
  newJiraIssueDraft: NewJiraIssueDraft | null
  setNewJiraIssueDraft: (draft: NewJiraIssueDraft) => void
  clearNewJiraIssueDraft: () => void
  newBusinessmapCardDraft: NewBusinessmapCardDraft | null
  setNewBusinessmapCardDraft: (draft: NewBusinessmapCardDraft) => void
  clearNewBusinessmapCardDraft: () => void
}

export const createTaskCreationDraftsSlice: StateCreator<
  AppState,
  [],
  [],
  TaskCreationDraftsSlice
> = (set) => ({
  newLinearIssueDraft: null,
  setNewLinearIssueDraft: (draft) => set({ newLinearIssueDraft: draft }),
  clearNewLinearIssueDraft: () => set({ newLinearIssueDraft: null }),
  newLinearProjectDraft: null,
  setNewLinearProjectDraft: (draft) => set({ newLinearProjectDraft: draft }),
  clearNewLinearProjectDraft: () => set({ newLinearProjectDraft: null }),
  newJiraIssueDraft: null,
  setNewJiraIssueDraft: (draft) => set({ newJiraIssueDraft: draft }),
  clearNewJiraIssueDraft: () => set({ newJiraIssueDraft: null }),
  newBusinessmapCardDraft: null,
  setNewBusinessmapCardDraft: (draft) => set({ newBusinessmapCardDraft: draft }),
  clearNewBusinessmapCardDraft: () => set({ newBusinessmapCardDraft: null })
})
