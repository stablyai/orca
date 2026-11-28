import { create } from 'zustand'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'

type TargetMode = { id: string; prompt: string }

/** The slice of app state the send menus read, for tests that render them without the app store. */
export type NotesSendTestState = {
  agentSendPopoverTargetMode: TargetMode | null
  diffNotesSendMenuOpenRequest: null
  openAgentSendPopoverTargetMode: (mode: TargetMode) => void
  closeAgentSendPopoverTargetMode: (id?: string) => void
  consumeDiffNotesSendMenuOpenRequest: () => void
  clearDeliveredDiffComments: () => Promise<boolean>
  deleteDiffCommentsByIds: (owner: DiffCommentOwner, ids: readonly string[]) => Promise<boolean>
}

export const notesSendTestStore = create<NotesSendTestState>()((set) => ({
  agentSendPopoverTargetMode: null,
  diffNotesSendMenuOpenRequest: null,
  openAgentSendPopoverTargetMode: (mode) =>
    set({ agentSendPopoverTargetMode: { id: mode.id, prompt: mode.prompt } }),
  closeAgentSendPopoverTargetMode: (id) =>
    set((state) =>
      !id || state.agentSendPopoverTargetMode?.id === id
        ? { agentSendPopoverTargetMode: null }
        : state
    ),
  consumeDiffNotesSendMenuOpenRequest: () => undefined,
  clearDeliveredDiffComments: async () => true,
  deleteDiffCommentsByIds: async () => true
}))

export function useNotesSendTestStateValue<T>(selector: (state: NotesSendTestState) => T): T {
  return notesSendTestStore(selector)
}
