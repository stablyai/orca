import { describe, expect, it } from 'vitest'
import type {
  ProviderRateLimits,
  ProviderRateLimitStatus
} from '../../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import type { UsageProviderSettings } from './status-bar-provider-visibility'
import {
  getPinnedUsageProviders,
  getUsageRosterProviders,
  isAntigravityUsageConfigured,
  type UsageProviderSnapshots
} from './usage-roster-provider-selection'

function provider(
  providerId: ProviderRateLimits['provider'],
  status: ProviderRateLimitStatus = 'ok'
): ProviderRateLimits {
  return {
    provider: providerId,
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status
  }
}

function snapshots(overrides: Partial<UsageProviderSnapshots> = {}): UsageProviderSnapshots {
  return {
    claude: null,
    codex: null,
    gemini: null,
    antigravity: null,
    'opencode-go': null,
    kimi: null,
    minimax: null,
    grok: null,
    ...overrides
  }
}

function settings(overrides: Partial<UsageProviderSettings> = {}): UsageProviderSettings {
  return {
    codexManagedAccounts: [],
    claudeManagedAccounts: [],
    opencodeSessionCookie: '',
    geminiCliOAuthEnabled: false,
    antigravityUsageConfigured: false,
    minimaxCookieConfigured: false,
    grokAuthConfigured: false,
    ...overrides
  }
}

describe('getUsageRosterProviders', () => {
  it('includes every configured provider in stable roster order', () => {
    const providers = getUsageRosterProviders({
      snapshots: snapshots({
        grok: provider('grok'),
        claude: provider('claude'),
        minimax: provider('minimax')
      }),
      settings: settings()
    })

    expect(providers.map((entry) => entry.provider)).toEqual(['claude', 'minimax', 'grok'])
  })

  it('keeps durably configured providers while their first snapshot is pending', () => {
    const providers = getUsageRosterProviders({
      snapshots: snapshots(),
      settings: settings({ minimaxCookieConfigured: true })
    })

    expect(providers).toMatchObject([{ provider: 'minimax', status: 'fetching' }])
  })

  it('keeps detected Antigravity in the roster when unpinned with a null or unavailable snapshot', () => {
    const providerSettings = settings({
      antigravityUsageConfigured: isAntigravityUsageConfigured(['antigravity']),
      geminiCliOAuthEnabled: true
    })
    for (const antigravity of [null, provider('antigravity', 'unavailable')]) {
      const rosterProviders = getUsageRosterProviders({
        snapshots: snapshots({ antigravity }),
        settings: providerSettings
      })
      const pinnedProviders = getPinnedUsageProviders({
        rosterProviders,
        statusBarItems: [] as StatusBarItem[],
        detectedAgentIds: ['antigravity']
      })

      expect(rosterProviders).toContainEqual(expect.objectContaining({ provider: 'antigravity' }))
      expect(pinnedProviders).toEqual([])
    }
  })

  it('omits unavailable providers without durable configuration', () => {
    const providers = getUsageRosterProviders({
      snapshots: snapshots({ codex: provider('codex', 'unavailable') }),
      settings: settings()
    })

    expect(providers).toEqual([])
  })
})

describe('getPinnedUsageProviders', () => {
  it('limits the footer to pinned providers without removing unpinned providers from the roster', () => {
    const rosterProviders = [provider('claude'), provider('codex')]
    const pinned = getPinnedUsageProviders({
      rosterProviders,
      statusBarItems: ['claude'] as StatusBarItem[],
      detectedAgentIds: ['claude', 'codex'] as TuiAgent[]
    })

    expect(pinned.map((entry) => entry.provider)).toEqual(['claude'])
    expect(rosterProviders.map((entry) => entry.provider)).toEqual(['claude', 'codex'])
  })

  it('applies PATH detection only to the pinned footer', () => {
    const rosterProviders = [provider('claude'), provider('minimax')]
    const pinned = getPinnedUsageProviders({
      rosterProviders,
      statusBarItems: ['claude', 'minimax'] as StatusBarItem[],
      detectedAgentIds: []
    })

    expect(pinned.map((entry) => entry.provider)).toEqual(['minimax'])
    expect(rosterProviders.map((entry) => entry.provider)).toEqual(['claude', 'minimax'])
  })
})
