import { describe, expect, it } from 'vitest'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import { resolveStatusBarUsageRateLimits } from './usage-rate-limits-source'

function localState(): RateLimitState {
  return {
    claude: {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: 1,
      error: 'Refresh failed',
      status: 'error'
    },
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    minimaxCookieConfigured: true,
    grokAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  } as RateLimitState
}

function remoteState(): RateLimitState {
  return { ...localState(), minimaxCookieConfigured: false }
}

describe('resolveStatusBarUsageRateLimits', () => {
  it('shows local usage when no remote Active Server owns accounts', () => {
    const local = localState()
    expect(resolveStatusBarUsageRateLimits(local, remoteState(), false)).toBe(local)
  })

  it('shows the remote snapshot when a remote Active Server owns accounts (#15798)', () => {
    const local = localState()
    const remote = remoteState()
    const resolved = resolveStatusBarUsageRateLimits(local, remote, true)
    expect(resolved).toBe(remote)
  })

  it('degrades to a fetching state rather than flashing local numbers before the first snapshot', () => {
    const local = localState()
    const resolved = resolveStatusBarUsageRateLimits(local, null, true)
    expect(resolved.claude).toMatchObject({ status: 'fetching' })
    // The stale local error must not read as the remote machine's state.
    expect(resolved.claude).not.toMatchObject({ status: 'error' })
    // Durability flags stay local so provider bars keep their visibility rules.
    expect(resolved.minimaxCookieConfigured).toBe(true)
  })

  it('keeps a null provider null in the fetching degrade', () => {
    const resolved = resolveStatusBarUsageRateLimits(localState(), null, true)
    expect(resolved.codex).toBeNull()
  })
})
