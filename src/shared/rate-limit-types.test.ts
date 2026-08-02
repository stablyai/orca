import { describe, expect, it } from 'vitest'
import type { RateLimitState } from './rate-limit-types'

describe('RateLimitState', () => {
  it('documents provider surfaces used by settings and status-bar UI', () => {
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
      antigravity: null,
      minimax: null,
      grok: null,
      minimaxCookieConfigured: false,
      grokAuthConfigured: false,
      claudeTarget: { runtime: 'host', wslDistro: null },
      codexTarget: { runtime: 'host', wslDistro: null },
      inactiveClaudeAccounts: [],
      inactiveCodexAccounts: []
    }

    expect(state.antigravity).toBeNull()
    expect(state.minimax).toBeNull()
    expect(state.minimaxCookieConfigured).toBe(false)
  })
})
