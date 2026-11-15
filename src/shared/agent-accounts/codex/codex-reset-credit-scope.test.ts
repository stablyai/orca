import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../agent-usage/rate-limits/rate-limit-types'
import type { CodexManagedAccountSummary } from '../managed-account-types'
import { buildCodexResetCreditExpectedScope } from './codex-reset-credit-scope'

const account: CodexManagedAccountSummary = {
  id: 'account-host',
  email: 'dev@example.com',
  managedHomeRuntime: 'host',
  wslDistro: null,
  createdAt: 10,
  updatedAt: 20,
  lastAuthenticatedAt: 20
}

const limits: ProviderRateLimits = {
  provider: 'codex',
  session: {
    usedPercent: 100,
    windowMinutes: 300,
    resetsAt: 1_000,
    resetDescription: 'soon'
  },
  weekly: null,
  rateLimitResetCredits: {
    availableCount: 1,
    totalEarnedCount: 2,
    nextExpiresAt: 2_000,
    credits: [{ status: 'available', expiresAt: 2_000, grantedAt: 500 }]
  },
  updatedAt: 30,
  error: null,
  status: 'ok'
}

describe('buildCodexResetCreditExpectedScope', () => {
  it.each([
    {
      name: 'system default account',
      target: { runtime: 'host', wslDistro: null } as const,
      candidate: null,
      candidateLimits: limits
    },
    {
      name: 'no available credit',
      target: { runtime: 'host', wslDistro: null } as const,
      candidate: account,
      candidateLimits: {
        ...limits,
        rateLimitResetCredits: { ...limits.rateLimitResetCredits!, availableCount: 0 }
      }
    },
    {
      name: 'unknown WSL distro',
      target: { runtime: 'wsl', wslDistro: null } as const,
      candidate: { ...account, managedHomeRuntime: 'wsl' as const, wslDistro: 'Ubuntu' },
      candidateLimits: limits
    },
    {
      name: 'runtime mismatch',
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' } as const,
      candidate: account,
      candidateLimits: limits
    },
    {
      name: 'WSL distro mismatch',
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' } as const,
      candidate: { ...account, managedHomeRuntime: 'wsl' as const, wslDistro: 'Debian' },
      candidateLimits: limits
    }
  ])('fails closed for $name', ({ target, candidate, candidateLimits }) => {
    expect(
      buildCodexResetCreditExpectedScope({
        target,
        account: candidate,
        limits: candidateLimits
      })
    ).toBeNull()
  })
})
