import type { StateCreator } from 'zustand'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

export type RateLimitSlice = {
  rateLimits: RateLimitState
  fetchRateLimits: () => Promise<void>
  refreshRateLimits: () => Promise<void>
  setRateLimitsFromPush: (state: RateLimitState) => void
}

export const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice> = (set) => ({
  rateLimits: { claude: null, codex: null, gemini: null, opencodeGo: null },

  fetchRateLimits: async () => {
    try {
      const state = await window.api.rateLimits.get()
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to fetch rate limits:', error)
    }
  },

  refreshRateLimits: async () => {
    try {
      const state = await window.api.rateLimits.refresh()
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh rate limits:', error)
    }
  },

  setRateLimitsFromPush: (state) => {
    set({ rateLimits: state })
  }
})
