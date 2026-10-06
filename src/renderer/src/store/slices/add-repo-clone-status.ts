import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

/** Why: lets a lazy-mounted host (e.g. useLazyModalMounts) know a clone
 *  started from the Add Project dialog is still running, even after the
 *  dialog itself has been dismissed, so it can defer tearing the dialog
 *  down until the background clone settles. */
export type AddRepoCloneStatusSlice = {
  isAddRepoCloneInFlight: boolean
  setAddRepoCloneInFlight: (inFlight: boolean) => void
}

export const createAddRepoCloneStatusSlice: StateCreator<
  AppState,
  [],
  [],
  AddRepoCloneStatusSlice
> = (set) => ({
  isAddRepoCloneInFlight: false,
  setAddRepoCloneInFlight: (inFlight) => set({ isAddRepoCloneInFlight: inFlight })
})
