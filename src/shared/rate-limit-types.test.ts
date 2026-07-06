import { describe, expect, it } from 'vitest'
import type { RateLimitState } from './rate-limit-types'

describe('RateLimitState', () => {
  it('documents the MiniMax surface used by the AccountsPane settings UI', () => {
    // Why: the AccountsPane and the status bar both read these fields
    // from RateLimitState. The shape must stay stable so that the
    // visibility check (status-bar-provider-visibility) keeps working
    // across refactors.
    const state: RateLimitState = {
      claude: null,
      codex: null,
      gemini: null,
      opencodeGo: null,
      kimi: null,
      minimax: null,
      minimaxCookieConfigured: false,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }

    expect(state.minimax).toBeNull()
    expect(state.minimaxCookieConfigured).toBe(false)
  })
})
