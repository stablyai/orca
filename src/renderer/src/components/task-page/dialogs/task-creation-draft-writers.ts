import { useAppStore } from '@/store'
import { isTaskCreationDraftContentful } from '@/store/slices/task-creation-drafts'
import type {
  NewJiraIssueDraft,
  NewLinearIssueDraft,
  NewLinearProjectDraft
} from '@/store/slices/task-creation-drafts'

export function writeNewLinearProjectDraft(draft: NewLinearProjectDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewLinearProjectDraft(draft)
  } else {
    state.clearNewLinearProjectDraft()
  }
}

export function writeNewLinearIssueDraft(draft: NewLinearIssueDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewLinearIssueDraft(draft)
  } else {
    state.clearNewLinearIssueDraft()
  }
}

export function writeNewJiraIssueDraft(draft: NewJiraIssueDraft | null): void {
  const state = useAppStore.getState()
  if (draft && isTaskCreationDraftContentful(draft)) {
    state.setNewJiraIssueDraft(draft)
  } else {
    state.clearNewJiraIssueDraft()
  }
}
