import { expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-state-factory'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { workspaceAccountUsage } from './workspace-account-usage'

function reading(accountId: string, usedPercent: number): ProviderRateLimits {
  return {
    provider: 'claude',
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
    claude: reading('personal', 91),
    inactiveClaudeAccounts: [
      { accountId: 'work', rateLimits: reading('work', 27), updatedAt: 1, isFetching: false }
    ]
  })
  expect(workspaceAccountUsage(state, 'claude', 'work')?.session?.usedPercent).toBe(27)
  expect(workspaceAccountUsage(state, 'claude', 'personal')?.session?.usedPercent).toBe(91)
  expect(workspaceAccountUsage(state, 'claude', undefined)?.session?.usedPercent).toBe(91)
})

it('does not show the host default quota when the workspace account has no reading', () => {
  const state = createEmptyRateLimitState({ claude: reading('personal', 91) })
  const result = workspaceAccountUsage(state, 'claude', 'work')
  expect(result?.session).toBeNull()
  expect(result?.weekly).toBeNull()
  expect(result?.usageMetadata?.contextAccountId).toBe('work')
  expect(result?.status).toBe('unavailable')
})

it('rejects cached readings that identify a different account', () => {
  const state = createEmptyRateLimitState({
    claude: reading('personal', 91),
    inactiveClaudeAccounts: [
      { accountId: 'work', rateLimits: reading('personal', 91), updatedAt: 1, isFetching: false }
    ]
  })
  expect(workspaceAccountUsage(state, 'claude', 'work')?.session).toBeNull()
})

it('retains the owning host trust state when showing cached workspace usage', () => {
  const state = createEmptyRateLimitState({
    claude: { ...reading('personal', 91), usageMetadata: { unverifiableOwner: true } },
    inactiveClaudeAccounts: [
      { accountId: 'work', rateLimits: reading('work', 27), updatedAt: 1, isFetching: false }
    ]
  })
  const result = workspaceAccountUsage(state, 'claude', 'work')
  expect(result?.session).toBeNull()
  expect(result?.usageMetadata?.unverifiableOwner).toBe(true)
})

it('does not attribute a cached system-default reading to the workspace account', () => {
  const state = createEmptyRateLimitState({
    inactiveClaudeAccounts: [
      {
        accountId: 'work',
        rateLimits: { ...reading('personal', 91), usageMetadata: { authProvenance: 'system' } },
        updatedAt: 1,
        isFetching: false
      }
    ]
  })
  expect(workspaceAccountUsage(state, 'claude', 'work')?.session).toBeNull()
})

it('shows the system-default preview for a system-default workspace while the host uses another account', () => {
  const state = createEmptyRateLimitState({
    claude: reading('work', 91),
    inactiveClaudeAccounts: [
      {
        accountId: 'system-default:host:["personal@example.com","personal-org"]',
        rateLimits: { ...reading('unused', 38), usageMetadata: { authProvenance: 'system' } },
        updatedAt: 1,
        isFetching: false
      }
    ]
  })
  expect(workspaceAccountUsage(state, 'claude', 'system-default')?.session?.usedPercent).toBe(38)
  expect(workspaceAccountUsage(state, 'claude', 'work')?.session?.usedPercent).toBe(91)
})

it('does not show an unlabeled managed-account reading as System default usage', () => {
  const state = createEmptyRateLimitState({
    claude: {
      ...reading('work', 91),
      usageMetadata: { authProvenance: 'profile:work' }
    }
  })
  expect(workspaceAccountUsage(state, 'claude', 'system-default')?.session).toBeNull()
})
