/**
 * The Tasks page issue-drafting panel: whether it is open and which chat each repo uses.
 *
 * Why a standalone store: the toolbar toggle and the panel live in separate Task page subtrees,
 * and the chat must survive leaving Tasks so the same conversation reopens.
 */
import { create } from 'zustand'
import type { IssueDraftChat } from '@/lib/issue-draft-agent-launch'

type IssueDraftPanelState = {
  open: boolean
  chatByRepoId: Record<string, IssueDraftChat>
  setOpen: (open: boolean) => void
  setChat: (repoId: string, chat: IssueDraftChat | null) => void
}

export const useIssueDraftPanelStore = create<IssueDraftPanelState>((set) => ({
  open: false,
  chatByRepoId: {},
  setOpen: (open) => set({ open }),
  setChat: (repoId, chat) =>
    set((state) => {
      const chatByRepoId = { ...state.chatByRepoId }
      if (chat) {
        chatByRepoId[repoId] = chat
      } else {
        delete chatByRepoId[repoId]
      }
      return { chatByRepoId }
    })
}))
