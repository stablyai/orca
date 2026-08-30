import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { getVisibleUsageProvider, isUsageEmptyState } from './status-bar-provider-visibility'
import { getProviderUsageStatusLabel } from './usage-error-copy'
import { latestUsageUpdatedAt, resolveStatusBarUsageRateLimits } from './usage-rate-limits-source'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replaceAll(`{{${key}}}`, value)
    }
    return result
  }
}))

const PROVIDER_KEYS = [
  'claude',
  'codex',
  'gemini',
  'opencodeGo',
  'kimi',
  'antigravity',
  'minimax',
  'grok'
] as const

function providerWithUsage(
  provider: ProviderRateLimits['provider'],
  usedPercent: number,
  updatedAt: number
): ProviderRateLimits {
  return {
    provider,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    // Why: the reported symptom is a *valid-looking* local snapshot leaking, so
    // the fixture carries both real windows and a stale local error string.
    error: 'Refresh failed',
    status: 'error'
  }
}

function localState(): RateLimitState {
  return {
    claude: providerWithUsage('claude', 42, 1_000),
    codex: providerWithUsage('codex', 43, 1_000),
    gemini: providerWithUsage('gemini', 44, 1_000),
    opencodeGo: providerWithUsage('opencode-go', 45, 1_000),
    kimi: providerWithUsage('kimi', 46, 1_000),
    antigravity: providerWithUsage('antigravity', 47, 1_000),
    minimax: providerWithUsage('minimax', 48, 1_000),
    grok: providerWithUsage('grok', 49, 1_000),
    minimaxCookieConfigured: true,
    grokAuthConfigured: true,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

function remoteState(): RateLimitState {
  return {
    ...localState(),
    claude: providerWithUsage('claude', 71, 5_000),
    minimaxCookieConfigured: false,
    grokAuthConfigured: false
  }
}

describe('resolveStatusBarUsageRateLimits', () => {
  it('shows local usage when no remote Active Server owns accounts', () => {
    const local = localState()
    expect(resolveStatusBarUsageRateLimits(local, { kind: 'local' })).toBe(local)
  })

  it("shows the owning server's numbers once its snapshot lands (#15798)", () => {
    const resolved = resolveStatusBarUsageRateLimits(localState(), {
      kind: 'remote',
      rateLimits: remoteState()
    })
    expect(resolved.claude?.session?.usedPercent).toBe(71)
    // Why: the server owns sign-in state too, so its flags win when it sends them.
    expect(resolved.minimaxCookieConfigured).toBe(false)
    expect(resolved.grokAuthConfigured).toBe(false)
  })

  it('falls back to local durability flags when the host predates them', () => {
    // Why: RateLimitState declares both flags as required, but an older remote
    // Orca omits them entirely. Reading them raw would hide configured bars.
    const preFlagHost = remoteState()
    delete (preFlagHost as Partial<RateLimitState>).minimaxCookieConfigured
    delete (preFlagHost as Partial<RateLimitState>).grokAuthConfigured

    const resolved = resolveStatusBarUsageRateLimits(localState(), {
      kind: 'remote',
      rateLimits: preFlagHost
    })

    expect(resolved.minimaxCookieConfigured).toBe(true)
    expect(resolved.grokAuthConfigured).toBe(true)
  })

  it('never renders local percentages while the first remote snapshot is in flight', () => {
    const resolved = resolveStatusBarUsageRateLimits(localState(), { kind: 'remote-pending' })

    // Why: #15798 calls valid-looking local numbers "arguably worse than an
    // error state". Every provider must be blank, not just the null ones.
    for (const key of PROVIDER_KEYS) {
      const provider = resolved[key]
      expect(provider?.status).toBe('fetching')
      expect(provider?.session).toBeNull()
      expect(provider?.weekly).toBeNull()
      expect(provider?.error).toBeNull()
      expect(provider?.updatedAt).toBe(0)
    }
  })

  it('reports an unreachable owner instead of a spinner or a healthy bar', () => {
    const resolved = resolveStatusBarUsageRateLimits(localState(), {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable'
    })

    for (const key of PROVIDER_KEYS) {
      const provider = resolved[key]
      // docs/reference/ssh-execution-boundary.md: loss of contact is its own
      // verdict — never 0%, never "still loading".
      expect(provider?.status).toBe('error')
      expect(provider?.error).toBe('Usage unavailable — cannot reach Mac Mini')
      expect(provider?.session).toBeNull()
      expect(provider?.weekly).toBeNull()
    }
  })

  it('does not invent bars for providers the viewer never set up (#15804)', () => {
    const local = localState()
    local.minimax = null
    local.opencodeGo = {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: 2_000,
      error: 'Session cookie not configured',
      status: 'unavailable'
    }
    local.minimaxCookieConfigured = false

    const resolved = resolveStatusBarUsageRateLimits(local, {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable'
    })
    const settings = {
      antigravityUsageConfigured: false,
      minimaxCookieConfigured: resolved.minimaxCookieConfigured,
      grokAuthConfigured: resolved.grokAuthConfigured
    }

    // Why: an 'error' snapshot reads as "configured" to the visibility gate, so
    // stamping unconfigured providers pins bars the user never enabled.
    expect(resolved.minimax).toBeNull()
    expect(resolved.opencodeGo?.status).toBe('unavailable')
    expect(getVisibleUsageProvider('minimax', resolved.minimax, settings)).toBeNull()
    expect(getVisibleUsageProvider('opencode-go', resolved.opencodeGo, settings)).toBeNull()
    // Grok is configured locally, so its bar survives carrying the honest verdict.
    expect(getVisibleUsageProvider('grok', resolved.grok, settings)?.error).toBe(
      'Usage unavailable — cannot reach Mac Mini'
    )
  })

  it('says the owner does not report usage instead of claiming it is unreachable', () => {
    // Why: a host too old to publish rateLimits answered us; "cannot reach" it
    // would be a false statement about a server that is plainly live.
    const resolved = resolveStatusBarUsageRateLimits(localState(), {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'usage-not-published'
    })

    expect(resolved.claude?.error).toBe('Usage unavailable — Mac Mini does not report usage')
    expect(resolved.claude?.status).toBe('error')
    expect(resolved.claude?.session).toBeNull()
  })

  it('labels an unverifiable owner as unavailable rather than "Refresh failed"', () => {
    const resolved = resolveStatusBarUsageRateLimits(localState(), {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable'
    })

    // Why: the inline badge label is the string #15798 complains about; without
    // the marker it reads "Refresh failed", blaming a fetch that never ran.
    for (const key of PROVIDER_KEYS) {
      expect(getProviderUsageStatusLabel(resolved[key]!)).toBe('Usage unavailable')
    }
  })

  it('keeps the bars the unreachable server vouched for, blanked (#15798)', () => {
    // Thin client: nothing configured locally, everything configured on the server.
    const thinClient = localState()
    for (const key of PROVIDER_KEYS) {
      thinClient[key] = null
    }
    thinClient.minimaxCookieConfigured = false
    thinClient.grokAuthConfigured = false

    const resolved = resolveStatusBarUsageRateLimits(thinClient, {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable',
      lastKnown: localState()
    })

    // Why: dropping the last snapshot would make the server's bars vanish on a
    // viewer that has none of those providers set up locally.
    expect(resolved.claude?.status).toBe('error')
    expect(resolved.claude?.session).toBeNull()
    expect(resolved.claude?.error).toBe('Usage unavailable — cannot reach Mac Mini')
  })

  it('leaves the usage setup CTA reachable when nothing is configured (#15804)', () => {
    const unconfigured = localState()
    for (const key of PROVIDER_KEYS) {
      unconfigured[key] = {
        provider: key === 'opencodeGo' ? 'opencode-go' : key,
        session: null,
        weekly: null,
        updatedAt: 2_000,
        error: 'Not signed in',
        status: 'unavailable'
      }
    }
    unconfigured.minimaxCookieConfigured = false
    unconfigured.grokAuthConfigured = false

    const resolved = resolveStatusBarUsageRateLimits(unconfigured, {
      kind: 'remote-unverifiable',
      ownerLabel: 'Mac Mini',
      reason: 'unreachable'
    })

    // Why: synthesized 'error' snapshots count as configured providers, which
    // would silently swallow the "connect an account" empty state.
    expect(
      isUsageEmptyState(
        {
          claude: resolved.claude,
          codex: resolved.codex,
          gemini: resolved.gemini,
          opencodeGo: resolved.opencodeGo,
          kimi: resolved.kimi,
          antigravity: resolved.antigravity,
          minimax: resolved.minimax,
          grok: resolved.grok
        },
        {
          antigravityUsageConfigured: false,
          minimaxCookieConfigured: false,
          grokAuthConfigured: false
        }
      )
    ).toBe(true)
  })
})

describe('latestUsageUpdatedAt', () => {
  it('returns the newest provider timestamp', () => {
    expect(latestUsageUpdatedAt(remoteState())).toBe(5_000)
  })

  it('returns 0 when nothing has landed', () => {
    expect(latestUsageUpdatedAt(null)).toBe(0)
  })
})

/**
 * Why a source assertion: the resolver is pure, so reverting StatusBar back to
 * the raw `rateLimits` store slice would leave every behavioural test above
 * green while restoring the reported bug. This pins the one wiring line that
 * decides which machine the badges describe.
 */
describe('StatusBar badge source wiring', () => {
  const source = readFileSync(resolve(__dirname, 'StatusBar.tsx'), 'utf8')

  it('destructures the rendered providers from the resolved state', () => {
    expect(source).toMatch(
      /const \{ claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok \} =\s*\n?\s*effectiveRateLimits/
    )
  })

  it('reads the durability flags from the resolved state', () => {
    expect(source).toContain('minimaxCookieConfigured: effectiveRateLimits.minimaxCookieConfigured')
    expect(source).toContain('grokAuthConfigured: effectiveRateLimits.grokAuthConfigured')
  })

  it("does not hide the owning server's bars behind this laptop's PATH detection", () => {
    // Why: detectedAgentIds is local-only, so gating a remote server's bars on
    // it hides them entirely on the thin client #15798 is about.
    expect(source).toContain(
      "const usageDetectedAgentIds = remoteUsage.state.kind === 'local' ? detectedAgentIds : null"
    )
    expect(source).not.toMatch(/isStatusBarItemAvailable\('[a-z-]+', detectedAgentIds\)/)
  })

  it('rebuilds the refresh callback when the owning server changes', () => {
    // Why: refreshRateLimits/refreshDetectedAgents are stable store selectors,
    // so without the hook's owner-keyed refresh in the deps the closure would
    // keep refreshing the machine that was active when it was first created.
    expect(source).toContain(
      '}, [isRefreshing, remoteUsage.refresh, refreshRateLimits, refreshDetectedAgents])'
    )
  })
})
