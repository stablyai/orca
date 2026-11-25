import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/orca-profiles/constants'
import { createCodexAccountActionRunner } from '../accounts-pane-account-actions'
import { getCodexSystemDefaultSubtitle } from './accounts-pane-runtime'
import type { CodexRateLimitAccountsState } from '../../../../../../shared/agent-accounts/managed-account-types'
import type { CodexAccountActionRunner } from '../accounts-pane-types'
import {
  getSystemDefaultLanes,
  clearsHiddenWslLanes,
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

function state(
  wslActive: string | null,
  hostActive: string | null = null
): CodexRateLimitAccountsState {
  const value: CodexRateLimitAccountsState = {
    accounts: [hostAccount, wslAccount],
    activeAccountId: hostActive,
    activeAccountIdsByRuntime: { host: hostActive, wsl: { Ubuntu: wslActive } }
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
  beforeEach(() => {
    vi.clearAllMocks()
  })

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
    expect(clearsHiddenWslLanes(getSystemDefaultLanes(host, candidates, accounts, true))).toBe(true)
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

  it('keeps local WSL panes on their own lane without the remote WSL note', () => {
    const localWsl = { runtime: 'wsl' as const, wslDistro: 'Ubuntu', label: 'WSL' }
    const accounts = state('wsl-account')
    const lanes = getSystemDefaultLanes(localWsl, accounts.accounts, accounts, false)
    expect(lanes).toEqual([wslLane])
    expect(clearsHiddenWslLanes(lanes)).toBe(false)
    expect(getCodexSystemDefaultSubtitle(undefined, 'WSL', undefined, false)).toBe(
      'Use your current WSL Codex login.'
    )
  })

  it('keeps the system identity when noting the WSL reset', () => {
    const identity = { authKind: 'oauth' as const, email: 'you@example.com' }
    expect(getCodexSystemDefaultSubtitle(identity, 'server', undefined, true)).toBe(
      'you@example.com · including WSL'
    )
  })

  it('keeps the pane busy for the whole sequence and reports a first-lane failure once', async () => {
    const pane = paneRunner(state('wsl-account'))
    const select = vi.fn().mockRejectedValueOnce(new Error('wsl lane failed'))

    await runSystemDefaultSelect([wslLane, hostLane], owner, pane.run, select)

    expect(pane.setCodexAction.mock.calls).toEqual([['select:system'], ['idle']])
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(select).toHaveBeenCalledTimes(1)
    expect(pane.setCodexAccounts).not.toHaveBeenCalled()
  })

  it('keeps an applied WSL lane when the host lane fails afterwards', async () => {
    const pane = paneRunner(state('wsl-account', 'host-account'))
    const wslCleared = state(null, 'host-account')
    const select = vi
      .fn()
      .mockResolvedValueOnce(wslCleared)
      .mockRejectedValueOnce(new Error('host lane failed'))

    await runSystemDefaultSelect([wslLane, hostLane], owner, pane.run, select)

    expect(pane.setCodexAccounts).toHaveBeenCalledWith(wslCleared)
    expect(mocks.markRestart).toHaveBeenCalledTimes(1)
    expect(mocks.markRestart.mock.calls[0][0]).toMatchObject({ target: wslLane })
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(pane.setCodexAction.mock.calls).toEqual([['select:system'], ['idle']])
  })

  it('raises one restart prompt when several lanes change', async () => {
    const pane = paneRunner(state('wsl-account', 'host-account'))
    const select = vi.fn().mockResolvedValue(state(null))

    await runSystemDefaultSelect([wslLane, hostLane], owner, pane.run, select)

    expect(mocks.markRestart).toHaveBeenCalledTimes(1)
    expect(mocks.markRestart.mock.calls[0][0]).toMatchObject({ target: hostLane })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

function paneRunner(codexAccounts: CodexRateLimitAccountsState) {
  const setCodexAction = vi.fn()
  const setCodexAccounts = vi.fn()
  const run = createCodexAccountActionRunner({
    settings: getDefaultSettings('/tmp'),
    accountOwner: owner,
    accountRuntime: host,
    isRemoteAccountScope: true,
    codexAccounts,
    setCodexAccounts,
    setCodexAccountsLoaded: vi.fn(),
    setCodexAction,
    fetchSettings: vi.fn(),
    recordFeatureInteraction: vi.fn(),
    isCurrentAccountOwner: () => true
  })
  return { run, setCodexAction, setCodexAccounts }
}
