import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../shared/rate-limit-types'
import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../shared/types'
import { selectAutoSwitchAccount } from './agent-rate-limit-auto-switch'

function limits(provider: 'claude' | 'codex', usedPercent: number): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok'
  }
}

function unavailableLimits(provider: 'claude' | 'codex'): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: 1,
    error: 'sign in',
    status: 'error'
  }
}

const emptyClaude: ClaudeRateLimitAccountsState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

const emptyCodex: CodexRateLimitAccountsState = {
  accounts: [],
  activeAccountId: null,
  activeAccountIdsByRuntime: { host: null, wsl: {} }
}

function rateLimitState(overrides: Partial<RateLimitState>): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: [],
    ...overrides
  }
}

describe('selectAutoSwitchAccount', () => {
  it('selects the lowest-usage inactive Codex account for the same runtime', () => {
    const result = selectAutoSwitchAccount({
      agent: 'codex',
      target: { runtime: 'host', wslDistro: null },
      accounts: {
        claude: emptyClaude,
        codex: {
          accounts: [
            {
              id: 'active',
              email: 'active@example.com',
              managedHomeRuntime: 'host',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'busy',
              email: 'busy@example.com',
              managedHomeRuntime: 'host',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'free',
              email: 'free@example.com',
              managedHomeRuntime: 'host',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ],
          activeAccountId: 'active',
          activeAccountIdsByRuntime: { host: 'active', wsl: {} }
        },
        rateLimits: rateLimitState({
          inactiveCodexAccounts: [
            { accountId: 'busy', rateLimits: limits('codex', 95), updatedAt: 1, isFetching: false },
            { accountId: 'free', rateLimits: limits('codex', 12), updatedAt: 1, isFetching: false }
          ]
        })
      }
    })

    expect(result).toMatchObject({
      accountId: 'free',
      label: 'free@example.com',
      usedPercent: 12
    })
  })

  it('skips unavailable and exhausted Claude accounts', () => {
    const result = selectAutoSwitchAccount({
      agent: 'claude',
      target: { runtime: 'host', wslDistro: null },
      accounts: {
        claude: {
          accounts: [
            {
              id: 'active',
              email: 'active@example.com',
              managedAuthRuntime: 'host',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'bad',
              email: 'bad@example.com',
              managedAuthRuntime: 'host',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'full',
              email: 'full@example.com',
              managedAuthRuntime: 'host',
              authMethod: 'subscription-oauth',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ],
          activeAccountId: 'active',
          activeAccountIdsByRuntime: { host: 'active', wsl: {} }
        },
        codex: emptyCodex,
        rateLimits: rateLimitState({
          inactiveClaudeAccounts: [
            {
              accountId: 'bad',
              rateLimits: unavailableLimits('claude'),
              updatedAt: 1,
              isFetching: false
            },
            {
              accountId: 'full',
              rateLimits: limits('claude', 100),
              updatedAt: 1,
              isFetching: false
            }
          ]
        })
      }
    })

    expect(result).toBeNull()
  })

  it('keeps WSL account selection scoped to the same distro', () => {
    const result = selectAutoSwitchAccount({
      agent: 'codex',
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      accounts: {
        claude: emptyClaude,
        codex: {
          accounts: [
            {
              id: 'active',
              email: 'active@example.com',
              managedHomeRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'debian',
              email: 'debian@example.com',
              managedHomeRuntime: 'wsl',
              wslDistro: 'Debian',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            },
            {
              id: 'ubuntu',
              email: 'ubuntu@example.com',
              managedHomeRuntime: 'wsl',
              wslDistro: 'Ubuntu',
              createdAt: 1,
              updatedAt: 1,
              lastAuthenticatedAt: 1
            }
          ],
          activeAccountId: null,
          activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: 'active' } }
        },
        rateLimits: rateLimitState({
          inactiveCodexAccounts: [
            {
              accountId: 'debian',
              rateLimits: limits('codex', 1),
              updatedAt: 1,
              isFetching: false
            },
            {
              accountId: 'ubuntu',
              rateLimits: limits('codex', 20),
              updatedAt: 1,
              isFetching: false
            }
          ]
        })
      }
    })

    expect(result?.accountId).toBe('ubuntu')
  })
})
