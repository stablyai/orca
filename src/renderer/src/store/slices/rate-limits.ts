import type { StateCreator } from 'zustand'
import type { RateLimitRuntimeTarget, RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

export type RateLimitSlice = {
  rateLimits: RateLimitState
  fetchRateLimits: () => Promise<void>
  refreshRateLimits: () => Promise<void>
  refreshClaudeRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  refreshCodexRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  fetchInactiveClaudeAccountUsage: () => Promise<void>
  fetchInactiveCodexAccountUsage: () => Promise<void>
  setRateLimitsFromPush: (state: RateLimitState) => void
}

export const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice> = (set, get) => ({
  rateLimits: {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },

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

  refreshClaudeRateLimitsForTarget: async (target) => {
    const current = get().rateLimits
    const targetChanged =
      current.claudeTarget.runtime !== target.runtime ||
      current.claudeTarget.wslDistro !== target.wslDistro
    set({
      rateLimits: {
        ...current,
        claudeTarget: target,
        claude:
          current.claude && !targetChanged
            ? { ...current.claude, status: 'fetching' }
            : {
                provider: 'claude',
                session: null,
                weekly: null,
                updatedAt: 0,
                error: null,
                status: 'fetching'
              }
      }
    })
    try {
      const state = await window.api.rateLimits.refreshClaudeForTarget(target)
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh Claude usage for runtime:', error)
    }
  },

  refreshCodexRateLimitsForTarget: async (target) => {
    const current = get().rateLimits
    const targetChanged =
      current.codexTarget.runtime !== target.runtime ||
      current.codexTarget.wslDistro !== target.wslDistro
    set({
      rateLimits: {
        ...current,
        codexTarget: target,
        codex:
          current.codex && !targetChanged
            ? { ...current.codex, status: 'fetching' }
            : {
                provider: 'codex',
                session: null,
                weekly: null,
                updatedAt: 0,
                error: null,
                status: 'fetching'
              }
      }
    })
    try {
      const state = await window.api.rateLimits.refreshCodexForTarget(target)
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh Codex usage for runtime:', error)
    }
  },

  fetchInactiveClaudeAccountUsage: async () => {
    try {
      await window.api.rateLimits.fetchInactiveClaudeAccounts()
    } catch (error) {
      console.error('Failed to fetch inactive Claude account usage:', error)
    }
  },

  fetchInactiveCodexAccountUsage: async () => {
    try {
      await window.api.rateLimits.fetchInactiveCodexAccounts()
    } catch (error) {
      console.error('Failed to fetch inactive Codex account usage:', error)
    }
  },

  setRateLimitsFromPush: (state) => {
    set({ rateLimits: state })
  }
})
