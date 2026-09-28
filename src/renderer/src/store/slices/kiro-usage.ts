import type { StateCreator } from 'zustand'
import type { AppState } from '../types'

// The read itself runs in the main process and publishes through the shared
// rate-limit state, so this slice only asks for it — there is nothing to merge.
export type KiroUsageSlice = {
  refreshKiroUsage: (force?: boolean) => Promise<void>
}

/** Renderer-side trigger only; the refreshed value arrives over the rate-limit push. */
export const createKiroUsageSlice: StateCreator<AppState, [], [], KiroUsageSlice> = () => ({
  refreshKiroUsage: async (force) => {
    try {
      await window.api.kiroUsage.refresh(force)
    } catch (error) {
      console.error('Failed to refresh Kiro usage:', error)
    }
  }
})
