import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { createCodexAccountActionRunner } from '../accounts-pane-account-actions'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { CodexAccountActionRunner } from '../accounts-pane-types'
import {
  getSystemDefaultLanes,
  lanesIncludeWsl,
  runSystemDefaultSelect,
  systemDefaultCandidates
} from './system-default-lanes'

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), markRestart: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, info: vi.fn() } }))
vi.mock('@/lib/agent-session/accounts/codex/codex-session-restart', () => ({
  markLiveCodexSessionsForRestart: mocks.markRestart,
  resolveCodexRestartPromptAccountLabel: () => 'label'
}))

const base = { email: 'a@example.com', createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1 }
const hostAccount = { ...base, id: 'host-account' }
const wslAccount = {
  ...base,
  id: 'wsl-account',
  managedHomeRuntime: 'wsl' as const,
  wslDistro: 'Ubuntu'
}
const host = { runtime: 'host' as const, label: 'server' }
const owner = { kind: 'environment' as const, environmentId: 'paired' }
const hostLane = { runtime: 'host' as const, wslDistro: null }
const wslLane = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

function state(wslActive: string | null): CodexRateLimitAccountsState {
  const value: CodexRateLimitAccountsState = {
    accounts: [hostAccount, wslAccount],
    activeAccountId: null,
    activeAccountIdsByRuntime: { host: null, wsl: { Ubuntu: wslActive } }
  }
  return value
}

/** Mirrors the pane runner: one action, one failure report, idle only once the whole operation settles. */
function runner(): { run: CodexAccountActionRunner; failures: unknown[]; lanes: unknown[] } {
  const failures: unknown[] = []
  const lanes: unknown[] = []
  const run: CodexAccountActionRunner = async (_action, operation, actionRuntime) => {
    lanes.push(actionRuntime)
    try {
      await operation()
    } catch (error) {
      failures.push(error)
    }
  }
  return { run, failures, lanes }
}

describe('System default lanes', () => {
  it('clears active remote WSL lanes first and the shown host lane last', () => {
    const accounts = state('wsl-account')
    expect(getSystemDefaultLanes(host, accounts.accounts, accounts, true)).toEqual([
      wslLane,
      hostLane
    ])
  })

  it('leaves WSL lanes alone when none is active or the owner is local', () => {
    const idle = state(null)
    expect(getSystemDefaultLanes(host, idle.accounts, idle, true)).toEqual([hostLane])
    const active = state('wsl-account')
    expect(getSystemDefaultLanes(host, active.accounts, active, false)).toEqual([hostLane])
  })

  it('judges an unknown remote platform from the full roster, like the Active badge', () => {
    const accounts = state('wsl-account')
    const visible = [hostAccount]
    const unknown = { remoteOwner: true, ownerPlatform: null }
    const candidates = systemDefaultCandidates(accounts.accounts, visible, unknown)
    expect(lanesIncludeWsl(getSystemDefaultLanes(host, candidates, accounts, true))).toBe(true)
    const known = { remoteOwner: true, ownerPlatform: 'linux' as const }
    expect(systemDefaultCandidates(accounts.accounts, visible, known)).toBe(visible)
  })

  it('runs every lane inside one runner action', async () => {
    const select = vi.fn().mockResolvedValue(state(null))
    const { run, failures, lanes } = runner()

    await runSystemDefaultSelect([wslLane, hostLane], owner, run, select)

    expect(select.mock.calls).toEqual([
      [owner, { accountId: null, ...wslLane }],
      [owner, { accountId: null, ...hostLane }]
    ])
    expect(lanes).toEqual([[wslLane, hostLane]])
    expect(failures).toEqual([])
  })

  it('stops at the first failing lane with one failure and leaves the host lane untouched', async () => {
    const failure = new Error('wsl lane failed')
    const select = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(state(null))
    const { run, failures } = runner()

    await runSystemDefaultSelect([wslLane, hostLane], owner, run, select)

    expect(select).toHaveBeenCalledTimes(1)
    expect(failures).toEqual([failure])
  })

  it('keeps the pane busy for the whole sequence and reports a partial failure once', async () => {
    const setCodexAction = vi.fn()
    const run = createCodexAccountActionRunner({
      settings: getDefaultSettings('/tmp'),
      accountOwner: owner,
      accountRuntime: host,
      isRemoteAccountScope: true,
      codexAccounts: state('wsl-account'),
      setCodexAccounts: vi.fn(),
      setCodexAccountsLoaded: vi.fn(),
      setCodexAction,
      fetchSettings: vi.fn(),
      recordFeatureInteraction: vi.fn(),
      isCurrentAccountOwner: () => true
    })
    const select = vi.fn().mockRejectedValueOnce(new Error('wsl lane failed'))

    await runSystemDefaultSelect([wslLane, hostLane], owner, run, select)

    expect(setCodexAction.mock.calls).toEqual([['select:system'], ['idle']])
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledTimes(1)
  })
})
