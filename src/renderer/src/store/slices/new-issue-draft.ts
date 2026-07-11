import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubAssignableUser } from '../../../../shared/types'

/** In-progress "New GitHub issue" composer draft. Session-only (never
 *  `persist`-wrapped, no disk surface): it exists so an accidental dismissal
 *  (outside click / Escape / Cancel) doesn't discard the user's input, and is
 *  cleared on a successful submit or app restart. */
export type NewIssueDraft = {
  title: string
  body: string
  labels: string[]
  assignees: GitHubAssignableUser[]
  repoId: string | null
}

export type NewIssueDraftSlice = {
  newIssueDraft: NewIssueDraft | null
  /** Shallow-merge the patch into the current draft, or into a fresh empty
   *  draft when none exists yet. */
  setNewIssueDraft: (patch: Partial<NewIssueDraft>) => void
  clearNewIssueDraft: () => void
}

// Why: a factory (not a shared module constant) so a partial patch that omits
// `labels`/`assignees` seeds fresh arrays rather than aliasing one singleton's —
// an in-place mutation of an empty draft would otherwise corrupt every future one.
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
