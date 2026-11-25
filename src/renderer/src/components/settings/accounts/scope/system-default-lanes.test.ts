import { describe, expect, it, vi } from 'vitest'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import {
  getSystemDefaultLanes,
  runSystemDefaultSelect,
  systemDefaultBlockedForClaude
} from './system-default-lanes'

const base = { email: 'a@example.com', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
const hostAccount = { ...base, id: 'host-account' }
const wslAccount = {
  ...base,
  id: 'wsl-account',
  managedHomeRuntime: 'wsl' as const,
  wslDistro: 'Ubuntu'
}
const host = { runtime: 'host' as const, label: 'server' }

function state(wslActive: string | null): CodexRateLimitAccountsState {
  return {
    accounts: [hostAccount, wslAccount],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: wslActive } }
  } as CodexRateLimitAccountsState
}

describe('System default lanes', () => {
  it('clears an active WSL lane on a remote Windows owner along with the host lane', () => {
    const accounts = state('wsl-account')
    expect(getSystemDefaultLanes(host, accounts.accounts, accounts, true)).toEqual([
      { runtime: 'host', wslDistro: null },
      { runtime: 'wsl', wslDistro: 'Ubuntu' }
    ])
  })

  it('leaves WSL lanes alone when none is active or the owner is local', () => {
    const idle = state(null)
    expect(getSystemDefaultLanes(host, idle.accounts, idle, true)).toEqual([
      { runtime: 'host', wslDistro: null }
    ])
    const active = state('wsl-account')
    expect(getSystemDefaultLanes(host, active.accounts, active, false)).toEqual([
      { runtime: 'host', wslDistro: null }
    ])
  })

  it('sends one targeted select per lane through the pane runner', async () => {
    const select = vi.fn().mockResolvedValue(state(null))
    const run = vi.fn(async (_action: string, operation: () => Promise<unknown>) => {
      await operation()
    })
    const owner = { kind: 'environment' as const, environmentId: 'paired' }
    const lanes = [
      { runtime: 'host' as const, wslDistro: null },
      { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    ]

    await runSystemDefaultSelect(lanes, owner, run, select)

    expect(select.mock.calls).toEqual([
      [owner, { accountId: null, runtime: 'host', wslDistro: null }],
      [owner, { accountId: null, runtime: 'wsl', wslDistro: 'Ubuntu' }]
    ])
    expect(run.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ['select:system', lanes[0]],
      ['select:system', lanes[1]]
    ])
  })

  it('blocks remote Claude System default only when a WSL lane needs clearing', () => {
    const wslLanes = [
      { runtime: 'host' as const, wslDistro: null },
      { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }
    ]
    expect(systemDefaultBlockedForClaude(wslLanes, true)).toBe(true)
    expect(systemDefaultBlockedForClaude(wslLanes.slice(0, 1), true)).toBe(false)
    expect(systemDefaultBlockedForClaude(wslLanes, false)).toBe(false)
  })
})
