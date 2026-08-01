import type { StateCreator } from 'zustand'
import type { RateLimitRuntimeTarget, RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'

// Why: forcing a server-side usage refresh serially re-fetches every provider
// and the inactive-account caches; give it the same headroom as mobile.
const REMOTE_USAGE_REFRESH_TIMEOUT_MS = 60_000

export type RemoteAccountRateLimits = {
  environmentId: string
  state: RateLimitState
}

export type RateLimitSlice = {
  rateLimits: RateLimitState
  // The active Remote Orca Server's usage snapshot (see #7973); null while local accounts own usage.
  remoteRateLimits: RemoteAccountRateLimits | null
  fetchRateLimits: () => Promise<void>
  refreshRateLimits: () => Promise<void>
  refreshGrokRateLimits: () => Promise<void>
  refreshClaudeRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  refreshCodexRateLimitsForTarget: (target: RateLimitRuntimeTarget) => Promise<void>
  consumeCodexRateLimitResetCredit: () => Promise<void>
  fetchInactiveClaudeAccountUsage: () => Promise<void>
  fetchInactiveCodexAccountUsage: () => Promise<void>
  setRateLimitsFromPush: (state: RateLimitState) => void
  setRemoteRateLimits: (environmentId: string, state: RateLimitState) => void
  clearRemoteRateLimits: () => void
  refreshRemoteAccountUsage: (environmentId: string) => Promise<void>
}

// Why: with a Remote Orca Server active the server owns provider accounts
// (#7973), so usage surfaces must read its snapshot — the local state describes
// this desktop's credentials, which are not the ones doing the remote work.
export function selectAccountOwnerRateLimits(s: AppState): RateLimitState {
  const environmentId = s.settings?.activeRuntimeEnvironmentId?.trim() || null
  if (environmentId && s.remoteRateLimits?.environmentId === environmentId) {
    return s.remoteRateLimits.state
  }
  return s.rateLimits
}

export const createRateLimitSlice: StateCreator<AppState, [], [], RateLimitSlice> = (set, get) => ({
  rateLimits: {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  },
  remoteRateLimits: null,

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

  refreshGrokRateLimits: async () => {
    try {
      const state = await window.api.rateLimits.refreshGrok()
      set({ rateLimits: state })
    } catch (error) {
      console.error('Failed to refresh Grok usage:', error)
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

  consumeCodexRateLimitResetCredit: async () => {
    try {
      const result = await window.api.rateLimits.consumeCodexResetCredit()
      set({ rateLimits: result.state })
    } catch (error) {
      console.error('Failed to consume Codex rate-limit reset:', error)
      throw error
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
  },

  setRemoteRateLimits: (environmentId, state) => {
    // Why: a slow subscription frame or refresh can resolve after the user
    // switches account owners; a stale owner's snapshot must not be presented
    // as the new owner's usage.
    const active = get().settings?.activeRuntimeEnvironmentId?.trim() || null
    if (active !== environmentId) {
      return
    }
    set({ remoteRateLimits: { environmentId, state } })
  },

  clearRemoteRateLimits: () => {
    set({ remoteRateLimits: null })
  },

  refreshRemoteAccountUsage: async (environmentId) => {
    try {
      // Why: refreshUsage forces the server's OAuth fetch lane (bypassing its
      // poll throttle), which is the only way the Fable/weekly windows move on
      // a headless host between statusline posts.
      const snapshot = await callRuntimeRpc<{ rateLimits: RateLimitState | null }>(
        { kind: 'environment', environmentId },
        'accounts.list',
        { refreshUsage: true },
        { timeoutMs: REMOTE_USAGE_REFRESH_TIMEOUT_MS }
      )
      if (snapshot.rateLimits) {
        get().setRemoteRateLimits(environmentId, snapshot.rateLimits)
      }
    } catch (error) {
      console.error('Failed to refresh remote account usage:', error)
    }
  }
})
