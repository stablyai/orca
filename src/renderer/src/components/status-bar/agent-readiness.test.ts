import { describe, expect, it } from 'vitest'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { buildAgentReadiness, shouldShowAgentReadiness } from './agent-readiness'

const claudeAccounts: ClaudeRateLimitAccountsState = {
  accounts: [
    {
      id: 'claude-active',
      email: 'active@claude.test',
      managedAuthRuntime: 'host',
      wslDistro: null,
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 3,
      lastAuthenticatedAt: 2
    },
    {
      id: 'claude-inactive',
      email: 'inactive@claude.test',
      managedAuthRuntime: 'host',
      wslDistro: null,
      authMethod: 'subscription-oauth',
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 2
    }
  ],
  activeAccountId: 'claude-active',
  activeAccountIdsByRuntime: { host: 'claude-active', wsl: {} }
}

const codexAccounts: CodexRateLimitAccountsState = {
  accounts: [
    {
      id: 'codex-active',
      email: 'active@codex.test',
      managedHomeRuntime: 'host',
      wslDistro: null,
      providerAccountId: 'provider-active',
      workspaceLabel: null,
      workspaceAccountId: null,
      createdAt: 1,
      updatedAt: 2,
      lastAuthenticatedAt: 2
    }
  ],
  activeAccountId: 'codex-active',
  activeAccountIdsByRuntime: { host: 'codex-active', wsl: {} }
}

function limits(
  provider: ProviderRateLimits['provider'],
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 10,
    error: null,
    status: 'ok',
    ...overrides
  }
}

function rateLimits(overrides: Partial<RateLimitState> = {}): RateLimitState {
  return {
    claude: limits('claude'),
    codex: limits('codex'),
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
    inactiveCodexAccounts: [],
    ...overrides
  }
}

describe('buildAgentReadiness', () => {
  it('hides providers that have neither an installed CLI nor a linked account', () => {
    const providers = buildAgentReadiness({
      claudeAccounts: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      codexAccounts: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      rateLimits: null,
      detectedAgentIds: [],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers.filter(shouldShowAgentReadiness)).toEqual([])
  })

  it('keeps providers in checking state while empty CLI detection is pending', () => {
    const providers = buildAgentReadiness({
      claudeAccounts: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      codexAccounts: {
        accounts: [],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} }
      },
      rateLimits: null,
      detectedAgentIds: [],
      detectionPending: true,
      systemDefaultLabel: 'System default'
    })

    expect(providers.filter(shouldShowAgentReadiness)).toHaveLength(2)
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ installed: null, state: 'checking', reason: 'cli-checking' })
      ])
    )
  })

  it('uses the active account for the provider summary without promoting unchecked inactive accounts', () => {
    const [claude] = buildAgentReadiness({
      claudeAccounts,
      codexAccounts,
      rateLimits: rateLimits(),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(claude.state).toBe('ready')
    expect(claude.activeAccount?.label).toBe('active@claude.test')
    expect(claude.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'claude-active', state: 'ready', active: true }),
        expect.objectContaining({ id: 'claude-inactive', state: 'unknown', active: false })
      ])
    )
  })

  it('maps an active Codex authentication failure to action required', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts,
      rateLimits: rateLimits({
        codex: limits('codex', {
          status: 'error',
          error: 'ChatGPT authentication required to read rate limits'
        })
      }),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers.find((provider) => provider.provider === 'codex')).toMatchObject({
      state: 'action-required',
      reason: 'sign-in-required'
    })
  })

  it('keeps network and provider failures distinct from signed-out accounts', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts,
      rateLimits: rateLimits({
        claude: limits('claude', {
          status: 'error',
          error: 'ECONNRESET',
          usageMetadata: { failureKind: 'network' }
        })
      }),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers[0]).toMatchObject({ state: 'degraded', reason: 'network' })
  })

  it('treats a Claude credential refresh as checking because sessions may remain usable', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts,
      rateLimits: rateLimits({
        claude: limits('claude', {
          status: 'error',
          error: 'Token refresh in progress',
          usageMetadata: { failureKind: 'stale-token' }
        })
      }),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers[0]).toMatchObject({ state: 'checking', reason: 'sign-in-refreshing' })
  })

  it('lets missing CLI availability override a healthy provider response', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts,
      rateLimits: rateLimits(),
      detectedAgentIds: ['claude'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers.find((provider) => provider.provider === 'codex')).toMatchObject({
      state: 'unavailable',
      reason: 'cli-unavailable'
    })
  })

  it('recognizes the Codex system-default API key without requiring ChatGPT usage', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts: {
        ...codexAccounts,
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: {} },
        systemDefault: {
          hasAuth: false,
          authKind: 'api-key',
          email: null,
          providerAccountId: null,
          workspaceLabel: null
        }
      },
      rateLimits: rateLimits({
        codex: limits('codex', {
          status: 'error',
          error: 'ChatGPT authentication required to read rate limits'
        })
      }),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    expect(providers.find((provider) => provider.provider === 'codex')).toMatchObject({
      state: 'ready',
      reason: 'api-key-configured',
      activeAccount: expect.objectContaining({ id: null, active: true })
    })
  })

  it('scopes WSL accounts and inactive snapshots to the polled distro', () => {
    const providers = buildAgentReadiness({
      claudeAccounts,
      codexAccounts: {
        accounts: [
          {
            ...codexAccounts.accounts[0],
            id: 'ubuntu',
            email: 'ubuntu@codex.test',
            managedHomeRuntime: 'wsl',
            wslDistro: 'Ubuntu'
          },
          {
            ...codexAccounts.accounts[0],
            id: 'debian',
            email: 'debian@codex.test',
            managedHomeRuntime: 'wsl',
            wslDistro: 'Debian'
          }
        ],
        activeAccountId: null,
        activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'ubuntu', Debian: 'debian' } }
      },
      rateLimits: rateLimits({
        codexTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
        inactiveCodexAccounts: [
          {
            accountId: 'debian',
            rateLimits: limits('codex', { status: 'error', error: 'network' }),
            updatedAt: 10,
            isFetching: false
          }
        ]
      }),
      detectedAgentIds: ['claude', 'codex'],
      detectionPending: false,
      systemDefaultLabel: 'System default'
    })

    const codex = providers.find((provider) => provider.provider === 'codex')
    expect(codex?.activeAccount?.id).toBe('ubuntu')
    expect(codex?.accounts.map((account) => account.id)).toEqual([null, 'ubuntu'])
  })
})
