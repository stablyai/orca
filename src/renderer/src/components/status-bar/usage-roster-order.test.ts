import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus
} from '../../../../shared/rate-limit-types'
import { buildUsageRosterProviders } from './usage-roster-order'

function snapshot(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  const status: ProviderRateLimitStatus = 'ok'
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status
  }
}

describe('buildUsageRosterProviders', () => {
  it('orders the roster Claude, Codex, Z.AI, then the existing providers', () => {
    const roster = buildUsageRosterProviders({
      claude: snapshot('claude'),
      codex: snapshot('codex'),
      zai: snapshot('zai'),
      gemini: snapshot('gemini'),
      antigravity: snapshot('antigravity'),
      opencodeGo: snapshot('opencode-go'),
      kimi: snapshot('kimi'),
      minimax: snapshot('minimax'),
      grok: snapshot('grok')
    })

    expect(roster.map((p) => p.provider)).toEqual([
      'claude',
      'codex',
      'zai',
      'gemini',
      'antigravity',
      'opencode-go',
      'kimi',
      'minimax',
      'grok'
    ])
  })

  it('keeps Z.AI ahead of the remaining providers and drops hidden slots', () => {
    const roster = buildUsageRosterProviders({
      claude: null,
      codex: snapshot('codex'),
      zai: snapshot('zai'),
      gemini: null,
      antigravity: null,
      opencodeGo: snapshot('opencode-go'),
      kimi: null,
      minimax: null,
      grok: null
    })

    expect(roster.map((p) => p.provider)).toEqual(['codex', 'zai', 'opencode-go'])
  })

  it('returns an empty roster when every slot is hidden', () => {
    const roster = buildUsageRosterProviders({
      claude: null,
      codex: null,
      zai: null,
      gemini: null,
      antigravity: null,
      opencodeGo: null,
      kimi: null,
      minimax: null,
      grok: null
    })

    expect(roster).toEqual([])
  })
})
