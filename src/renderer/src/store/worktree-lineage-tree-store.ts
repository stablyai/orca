import { create } from 'zustand'

export type WorktreeLineageTreeRequest = {
  /** The worktree id whose lineage tree is being viewed. */
  worktreeId: string
  /** The worktree id that was just linked (to highlight in the tree). */
  newlyLinkedId?: string
}

export type WorktreeLineageTreeState = {
  request: WorktreeLineageTreeRequest | null
  openLineageTree: (request: WorktreeLineageTreeRequest) => void
  closeLineageTree: () => void
}

export const useWorktreeLineageTreeStore = create<WorktreeLineageTreeState>()((set) => ({
  request: null,
  openLineageTree: (request) => set({ request }),
  closeLineageTree: () => set({ request: null })
}))
