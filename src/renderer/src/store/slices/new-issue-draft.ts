import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'

/** Keep issue draft in session memory across accidental dismissal; clear on successful submit/restart, never persist to disk. */
export type NewIssueDraft = {
  title: string
  body: string
  labels: string[]
  assignees: GitHubAssignableUser[]
  repoId: string | null
}

export type NewIssueDraftSlice = {
  newIssueDraft: NewIssueDraft | null
  /** Patch current draft, creating fresh defaults if absent. */
  setNewIssueDraft: (patch: Partial<NewIssueDraft>) => void
  clearNewIssueDraft: () => void
}

// Create fresh labels/assignees arrays; shared empty defaults alias future drafts after mutation.
function createEmptyNewIssueDraft(): NewIssueDraft {
  return { title: '', body: '', labels: [], assignees: [], repoId: null }
}

export const createNewIssueDraftSlice: StateCreator<AppState, [], [], NewIssueDraftSlice> = (
  set
) => ({
  newIssueDraft: null,
  setNewIssueDraft: (patch) =>
    set((state) => ({
      newIssueDraft: { ...(state.newIssueDraft ?? createEmptyNewIssueDraft()), ...patch }
    })),
  clearNewIssueDraft: () => set({ newIssueDraft: null })
})
