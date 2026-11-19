import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { workspaceCodexUsage } from './workspace-codex-usage'

function reading(accountId: string, usedPercent: number): ProviderRateLimits {
  return {
    provider: 'codex',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    status: 'ok',
    updatedAt: 1,
    error: null,
    usageMetadata: { readingAccount: { accountId, runtime: 'host', wslDistro: null } }
  }
}

it('shows workspace account usage while the host default stays on another account', () => {
  const state = createEmptyRateLimitState({
    codex: reading('personal', 91),
    inactiveCodexAccounts: [
      { accountId: 'work', rateLimits: reading('work', 27), updatedAt: 1, isFetching: false }
    ]
  })
  expect(workspaceCodexUsage(state, 'work')?.session?.usedPercent).toBe(27)
  expect(workspaceCodexUsage(state, 'personal')?.session?.usedPercent).toBe(91)
  expect(workspaceCodexUsage(state, undefined)?.session?.usedPercent).toBe(91)
})

it('does not show the host default quota when the workspace account has no reading', () => {
  const state = createEmptyRateLimitState({ codex: reading('personal', 91) })
  const result = workspaceCodexUsage(state, 'work')
  expect(result?.session).toBeNull()
  expect(result?.weekly).toBeNull()
  expect(result?.usageMetadata?.contextAccountId).toBe('work')
  expect(result?.status).toBe('unavailable')
})

it('rejects cached readings that identify a different account', () => {
  const state = createEmptyRateLimitState({
    codex: reading('personal', 91),
    inactiveCodexAccounts: [
      { accountId: 'work', rateLimits: reading('personal', 91), updatedAt: 1, isFetching: false }
    ]
  })
  expect(workspaceCodexUsage(state, 'work')?.session).toBeNull()
})

it('retains the owning host trust state when showing cached workspace usage', () => {
  const state = createEmptyRateLimitState({
    codex: { ...reading('personal', 91), usageMetadata: { unverifiableOwner: true } },
    inactiveCodexAccounts: [
      { accountId: 'work', rateLimits: reading('work', 27), updatedAt: 1, isFetching: false }
    ]
  })
  const result = workspaceCodexUsage(state, 'work')
  expect(result?.session).toBeNull()
  expect(result?.usageMetadata?.unverifiableOwner).toBe(true)
})

it('uses the real system-default quota rather than the managed host quota for that workspace', () => {
  const state = createEmptyRateLimitState({
    codex: reading('personal', 91),
    inactiveCodexAccounts: [
      {
        accountId: 'system-default:host:["system@example.com","system-login"]',
        rateLimits: reading('system-default:host:["system@example.com","system-login"]', 38),
        updatedAt: 1,
        isFetching: false
      }
    ]
  })
  expect(workspaceCodexUsage(state, 'system-default')?.session?.usedPercent).toBe(38)
  expect(
    workspaceCodexUsage(
      createEmptyRateLimitState({ codex: reading('personal', 91) }),
      'system-default'
    )?.session
  ).toBeNull()
})
