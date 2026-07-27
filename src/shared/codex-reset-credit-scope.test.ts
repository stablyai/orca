import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from './rate-limit-types'
import type { CodexManagedAccountSummary } from './types'
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
  it('builds a deterministic exact host scope', () => {
    const first = buildCodexResetCreditExpectedScope({
      target: { runtime: 'host', wslDistro: null },
      account,
      limits
    })
    const second = buildCodexResetCreditExpectedScope({
      target: { runtime: 'host', wslDistro: null },
      account,
      limits: {
        ...limits,
        rateLimitResetCredits: {
          ...limits.rateLimitResetCredits!,
          credits: [
            { status: 'available', expiresAt: 3_000, grantedAt: 600 },
            ...limits.rateLimitResetCredits!.credits!
          ].toReversed()
        }
      }
    })

    const firstWithBothRows = buildCodexResetCreditExpectedScope({
      target: { runtime: 'host', wslDistro: null },
      account,
      limits: {
        ...limits,
        rateLimitResetCredits: {
          ...limits.rateLimitResetCredits!,
          credits: [
            ...limits.rateLimitResetCredits!.credits!,
            { status: 'available', expiresAt: 3_000, grantedAt: 600 }
          ]
        }
      }
    })

    expect(firstWithBothRows).toEqual(second)
    expect(first).toMatchObject({
      target: { runtime: 'host', wslDistro: null },
      accountId: account.id,
      accountRevision: account.updatedAt,
      offerRevision: expect.stringMatching(/^v1:/)
    })
  })

  it('changes the offer revision when fetched credit or window data changes', () => {
    const original = buildCodexResetCreditExpectedScope({
      target: { runtime: 'host', wslDistro: null },
      account,
      limits
    })
    const refreshed = buildCodexResetCreditExpectedScope({
      target: { runtime: 'host', wslDistro: null },
      account,
      limits: { ...limits, updatedAt: limits.updatedAt + 1 }
    })

    expect(refreshed?.offerRevision).not.toBe(original?.offerRevision)
  })

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
