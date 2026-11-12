import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRunAction } from '../../../../shared/orca-yaml-hook-types'

type Tab = { id: string }
type MockState = {
  repos: { id: string; hookSettings?: unknown }[]
  tabsByWorktree: Record<string, Tab[]>
  unifiedTabsByWorktree: Record<
    string,
    { id: string; entityId: string; contentType: string; groupId: string }[]
  >
  ptyIdsByTabId: Record<string, string[]>
  terminalLayoutsByTabId: Record<string, unknown>
  createTab: ReturnType<typeof vi.fn>
  closeTab: ReturnType<typeof vi.fn>
  setTabCustomTitle: ReturnType<typeof vi.fn>
  setActiveTabType: ReturnType<typeof vi.fn>
}

type Subscriber = (state: unknown, previous: unknown) => void
const mocks = vi.hoisted(() => {
  const subscribers: ((state: unknown, previous: unknown) => void)[] = []
  return {
    ensureHooksConfirmed: vi.fn(async (): Promise<'run' | 'skip'> => 'run'),
    checkRuntimeHooks: vi.fn(),
    sendRuntimePtyInput: vi.fn(() => true),
    subscribers
  }
})

let state: MockState
let nextTab = 0

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: (listener: Subscriber) => {
      mocks.subscribers.push(listener)
      return () => {}
    }
  }
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => values?.[key] ?? '')
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }))
vi.mock('@/runtime/repo-hooks/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed: mocks.ensureHooksConfirmed
}))
vi.mock('@/runtime/repo-hooks/runtime-hooks-client', () => ({
  checkRuntimeHooks: mocks.checkRuntimeHooks
}))
vi.mock('@/runtime/hosted-terminals/input/runtime-terminal-input-send', () => ({
  sendRuntimePtyInput: mocks.sendRuntimePtyInput
}))
vi.mock('@/lib/agent-session/launch/pane/launch-agent-tab-order', () => ({
  persistAgentLaunchTabOrder: vi.fn()
}))
vi.mock('@/store/github/refresh/worktree-refresh', () => ({
  findWorktreeById: (_state: unknown, worktreeId: string) => {
    const [repoId, path] = worktreeId.split('::')
    return { id: worktreeId, repoId, path }
  }
}))

// The node test environment has no window; the run-action events only need its event target.
vi.stubGlobal('window', new EventTarget())

const { mergeRunActions, loadWorktreeRunActions } = await import('./run-action-config')
const { startRunAction, stopRunAction, relaunchInterruptedRunActions, armRunActionRelaunch } =
  await import('./run-action-controller')
const { installRunActionEvents, armAutoRunAfterSetup, autoRunProvisionedWorkspaceOnce } =
  await import('./run-action-events')
const { getRunActionRun, resetRunActionRunsForTests } = await import('./run-actions-store')
const { dispatchTerminalCommandFinishedEvent } =
  await import('@/hooks/terminal-command-finished-event')

const WT_A = 'repo-1::/work/a'
const WT_B = 'repo-1::/work/b'
const web: OrcaRunAction = {
  id: 'web',
  name: 'Web',
  command: 'pnpm dev --port $ORCA_PORT',
  cwd: 'apps/web',
  env: { A: '1' }
}

function makeState(): MockState {
  return {
    repos: [{ id: 'repo-1' }],
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    createTab: vi.fn((worktreeId: string) => {
      const tab = { id: `tab-${++nextTab}` }
      state.tabsByWorktree[worktreeId] = [...(state.tabsByWorktree[worktreeId] ?? []), tab]
      state.ptyIdsByTabId[tab.id] = [`pty-${nextTab}`]
      return tab
    }),
    closeTab: vi.fn((tabId: string) => {
      for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
        state.tabsByWorktree[worktreeId] = tabs.filter((tab) => tab.id !== tabId)
      }
    }),
    setTabCustomTitle: vi.fn(),
    setActiveTabType: vi.fn()
  }
}

function config(actions: OrcaRunAction[], runMode?: 'concurrent' | 'nonconcurrent') {
  return mergeRunActions({ run: actions, ...(runMode ? { runMode } : {}) }, undefined, 'local')
}

let uninstall: () => void
beforeEach(() => {
  vi.useFakeTimers()
  resetRunActionRunsForTests()
  state = makeState()
  mocks.ensureHooksConfirmed.mockClear()
  mocks.sendRuntimePtyInput.mockClear()
  mocks.checkRuntimeHooks.mockResolvedValue({ status: 'ok', hooks: { scripts: { run: [web] } } })
  uninstall = installRunActionEvents()
})
afterEach(() => {
  uninstall()
  vi.useRealTimers()
})

describe('run actions', () => {
  it('asks to trust shared actions, then opens a titled terminal in the action cwd with its env', async () => {
    expect(await startRunAction(WT_A, web, config([web]))).toBe(true)
    expect(mocks.ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.any(Function),
      'repo-1',
      'run',
      'local'
    )
    expect(state.createTab).toHaveBeenCalledWith(WT_A, undefined, undefined, {
      recordInteraction: true,
      activate: true,
      pendingStartup: { command: web.command, env: { A: '1' } },
      startupCwd: '/work/a/apps/web'
    })
    expect(state.setTabCustomTitle).toHaveBeenCalledWith(`tab-${nextTab}`, 'Run: Web', {
      recordInteraction: false
    })
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
  })

  it('does not start when the user declines the orca.yaml commands', async () => {
    mocks.ensureHooksConfirmed.mockResolvedValueOnce('skip')
    expect(await startRunAction(WT_A, web, config([web]))).toBe(false)
    expect(state.createTab).not.toHaveBeenCalled()
  })

  it('runs the user’s own (local) actions without a trust prompt', async () => {
    const local = mergeRunActions(undefined, { run: [web] }, 'local')
    await startRunAction(WT_A, web, local)
    expect(mocks.ensureHooksConfirmed).not.toHaveBeenCalled()
  })

  it('marks exits and failures from the terminal’s command-finished signal', async () => {
    await startRunAction(WT_A, web, config([web]))
    const tabId = getRunActionRun(WT_A, 'web')!.tabId
    dispatchTerminalCommandFinishedEvent(WT_A, 1, tabId)
    expect(getRunActionRun(WT_A, 'web')).toMatchObject({ status: 'failed', exitCode: 1 })
  })

  it('stops with an interrupt and settles as stopped when the command finishes', async () => {
    await startRunAction(WT_A, web, config([web]))
    const run = getRunActionRun(WT_A, 'web')!
    const stopping = stopRunAction(WT_A, 'web')
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledWith(
      state.ptyIdsByTabId[run.tabId][0],
      '\x03',
      'driving'
    )
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('stopping')
    dispatchTerminalCommandFinishedEvent(WT_A, 130, run.tabId)
    await stopping
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('stopped')
    expect(state.closeTab).not.toHaveBeenCalled()
  })

  it('closes the terminal when the action ignores the interrupt for the grace period', async () => {
    await startRunAction(WT_A, web, config([web]))
    const run = getRunActionRun(WT_A, 'web')!
    const stopping = stopRunAction(WT_A, 'web')
    await vi.advanceTimersByTimeAsync(5_000)
    await stopping
    expect(state.closeTab).toHaveBeenCalledWith(run.tabId, expect.any(Object))
    expect(getRunActionRun(WT_A, 'web')).toBeNull()
  })

  it('restart replaces the old terminal in the same group', async () => {
    await startRunAction(WT_A, web, config([web]))
    const first = getRunActionRun(WT_A, 'web')!
    state.unifiedTabsByWorktree[WT_A] = [
      { id: 'u1', entityId: first.tabId, contentType: 'terminal', groupId: 'g-7' }
    ]
    const restarting = startRunAction(WT_A, web, config([web]))
    await vi.advanceTimersByTimeAsync(0)
    dispatchTerminalCommandFinishedEvent(WT_A, 130, first.tabId)
    await restarting
    expect(state.closeTab).toHaveBeenCalledWith(first.tabId, expect.any(Object))
    expect(state.createTab).toHaveBeenLastCalledWith(WT_A, 'g-7', undefined, expect.any(Object))
    expect(getRunActionRun(WT_A, 'web')?.tabId).not.toBe(first.tabId)
  })

  it('nonconcurrent stops the project’s action in another workspace first', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { run: [web], runMode: 'nonconcurrent' } }
    })
    await startRunAction(WT_A, web, config([web], 'nonconcurrent'))
    const other = getRunActionRun(WT_A, 'web')!
    const starting = startRunAction(WT_B, web, config([web], 'nonconcurrent'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledWith(
      state.ptyIdsByTabId[other.tabId][0],
      '\x03',
      'driving'
    )
    dispatchTerminalCommandFinishedEvent(WT_A, 130, other.tabId)
    await starting
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('stopped')
    expect(getRunActionRun(WT_B, 'web')?.status).toBe('running')
  })

  it('nonconcurrent leaves the project’s other actions running, here and elsewhere', async () => {
    const worker: OrcaRunAction = { id: 'worker', name: 'Worker', command: 'pnpm worker' }
    mocks.checkRuntimeHooks.mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { run: [web, worker], runMode: 'nonconcurrent' } }
    })
    await startRunAction(WT_A, web, config([web, worker], 'nonconcurrent'))
    await startRunAction(WT_B, worker, config([web, worker], 'nonconcurrent'))
    const starting = startRunAction(WT_A, worker, config([web, worker], 'nonconcurrent'))
    await vi.advanceTimersByTimeAsync(0)
    // Only the same action in the other workspace is interrupted.
    expect(mocks.sendRuntimePtyInput).toHaveBeenCalledTimes(1)
    expect(getRunActionRun(WT_B, 'worker')?.status).toBe('stopping')
    dispatchTerminalCommandFinishedEvent(WT_B, 130, getRunActionRun(WT_B, 'worker')!.tabId)
    await starting
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
    expect(getRunActionRun(WT_A, 'worker')?.status).toBe('running')
  })

  it('concurrent leaves other workspaces running', async () => {
    await startRunAction(WT_A, web, config([web]))
    await startRunAction(WT_B, web, config([web]))
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
    expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
  })

  it('relaunches running actions after the host restarts, without taking focus', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({ status: 'ok', hooks: { scripts: { run: [web] } } })
    await startRunAction(WT_A, web, config([web]))
    const before = getRunActionRun(WT_A, 'web')!
    expect(await relaunchInterruptedRunActions(WT_A)).toBe(1)
    expect(state.closeTab).toHaveBeenCalledWith(before.tabId, expect.any(Object))
    expect(state.createTab).toHaveBeenLastCalledWith(
      WT_A,
      undefined,
      undefined,
      expect.objectContaining({ activate: false })
    )
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
  })

  it('does not relaunch actions that already exited', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({ status: 'ok', hooks: { scripts: { run: [web] } } })
    await startRunAction(WT_A, web, config([web]))
    dispatchTerminalCommandFinishedEvent(WT_A, 0, getRunActionRun(WT_A, 'web')!.tabId)
    expect(await relaunchInterruptedRunActions(WT_A)).toBe(0)
  })

  it('a double restart leaves exactly one tracked run and closes the rest', async () => {
    await startRunAction(WT_A, web, config([web]))
    const first = getRunActionRun(WT_A, 'web')!
    const one = startRunAction(WT_A, web, config([web]))
    const two = startRunAction(WT_A, web, config([web]))
    await vi.advanceTimersByTimeAsync(0)
    dispatchTerminalCommandFinishedEvent(WT_A, 130, first.tabId)
    await one
    const second = getRunActionRun(WT_A, 'web')!
    await vi.advanceTimersByTimeAsync(0)
    dispatchTerminalCommandFinishedEvent(WT_A, 130, second.tabId)
    await two
    const live = state.tabsByWorktree[WT_A].map((tab) => tab.id)
    expect(live).toEqual([getRunActionRun(WT_A, 'web')!.tabId])
  })

  it('keeps runs through a host restart even if the tab list is rebuilt before it settles', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({ status: 'ok', hooks: { scripts: { run: [web] } } })
    await startRunAction(WT_A, web, config([web]))
    armRunActionRelaunch(WT_A)
    const previous = { tabsByWorktree: { ...state.tabsByWorktree } }
    state.tabsByWorktree = { [WT_A]: [] }
    for (const listener of mocks.subscribers) {
      listener(state, previous)
    }
    expect(await relaunchInterruptedRunActions(WT_A)).toBe(1)
    expect(mocks.sendRuntimePtyInput).not.toHaveBeenCalled()
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
  })

  it('runs the orca.yaml command as approved, not a stale cached one', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { run: [{ ...web, command: 'pnpm dev:new' }] } }
    })
    await startRunAction(WT_A, web, config([web]))
    expect(state.createTab).toHaveBeenLastCalledWith(
      WT_A,
      undefined,
      undefined,
      expect.objectContaining({
        pendingStartup: expect.objectContaining({ command: 'pnpm dev:new' })
      })
    )
    mocks.checkRuntimeHooks.mockResolvedValue({ status: 'ok', hooks: { scripts: {} } })
    expect(await startRunAction(WT_B, web, config([web]))).toBe(false)
  })

  it('a command finishing in a split of the run tab does not end the run', async () => {
    await startRunAction(WT_A, web, config([web]))
    const { tabId } = getRunActionRun(WT_A, 'web')!
    const L1 = '11111111-1111-4111-8111-111111111111'
    const L2 = '22222222-2222-4222-8222-222222222222'
    const notifyLayouts = (): void => {
      for (const listener of mocks.subscribers) {
        listener(state, { tabsByWorktree: state.tabsByWorktree, terminalLayoutsByTabId: {} })
      }
    }
    state.terminalLayoutsByTabId = { [tabId]: { root: { type: 'leaf', leafId: L1 } } }
    notifyLayouts()
    expect(getRunActionRun(WT_A, 'web')?.leafId).toBe(L1)
    state.terminalLayoutsByTabId = {
      [tabId]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: L1 },
          second: { type: 'leaf', leafId: L2 }
        }
      }
    }
    notifyLayouts()
    dispatchTerminalCommandFinishedEvent(WT_A, 0, tabId, L2)
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
    dispatchTerminalCommandFinishedEvent(WT_A, 1, tabId, L1)
    expect(getRunActionRun(WT_A, 'web')).toMatchObject({ status: 'failed', exitCode: 1 })
  })

  it('ignores a pane it cannot attribute while the tab has several panes', async () => {
    await startRunAction(WT_A, web, config([web]))
    const { tabId } = getRunActionRun(WT_A, 'web')!
    state.terminalLayoutsByTabId = {
      [tabId]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: '11111111-1111-4111-8111-111111111111' },
          second: { type: 'leaf', leafId: '22222222-2222-4222-8222-222222222222' }
        }
      }
    }
    dispatchTerminalCommandFinishedEvent(WT_A, 0, tabId, '22222222-2222-4222-8222-222222222222')
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
  })

  it('auto-runs once on first open when the host ran setup in the environment build', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value)
    })
    try {
      const provisioned = { ...config([web]), setupProvisioned: true as const }
      provisioned.scripts = { ...provisioned.scripts, autoRunAfterSetup: true }
      expect(await autoRunProvisionedWorkspaceOnce(WT_A, provisioned)).toBe(true)
      expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
      dispatchTerminalCommandFinishedEvent(WT_A, 0, getRunActionRun(WT_A, 'web')!.tabId)
      expect(await autoRunProvisionedWorkspaceOnce(WT_A, provisioned)).toBe(false)
      const notProvisioned = { ...provisioned, setupProvisioned: undefined }
      expect(await autoRunProvisionedWorkspaceOnce(WT_B, notProvisioned)).toBe(false)
    } finally {
      vi.stubGlobal('localStorage', undefined)
    }
  })

  it('auto-runs the default action once setup succeeds, not when it fails', async () => {
    mocks.checkRuntimeHooks.mockResolvedValue({
      status: 'ok',
      hooks: { scripts: { run: [web], autoRunAfterSetup: true } }
    })
    armAutoRunAfterSetup(WT_A, 'setup-1')
    dispatchTerminalCommandFinishedEvent(WT_A, 1, 'setup-1')
    await vi.advanceTimersByTimeAsync(0)
    expect(state.createTab).not.toHaveBeenCalled()
    armAutoRunAfterSetup(WT_A, 'setup-2')
    dispatchTerminalCommandFinishedEvent(WT_A, 0, 'setup-2')
    await vi.advanceTimersByTimeAsync(0)
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
  })

  it('forgets a run only when its terminal is still gone after the tab list settles', async () => {
    await startRunAction(WT_A, web, config([web]))
    const { tabId } = getRunActionRun(WT_A, 'web')!
    const notify = (): void => {
      const previous = { tabsByWorktree: {} }
      for (const listener of mocks.subscribers) {
        listener(state, previous)
      }
    }
    // A window reload briefly shows an empty list, then the tab comes back: keep the run.
    const kept = state.tabsByWorktree[WT_A]
    state.tabsByWorktree = { [WT_A]: [] }
    notify()
    state.tabsByWorktree = { [WT_A]: kept }
    await vi.advanceTimersByTimeAsync(16_000)
    expect(getRunActionRun(WT_A, 'web')?.tabId).toBe(tabId)
    // Really closed: gone after the settle delay.
    state.tabsByWorktree = { [WT_A]: [] }
    notify()
    await vi.advanceTimersByTimeAsync(3_500)
    expect(getRunActionRun(WT_A, 'web')).toBeNull()
  })

  it('follows a run whose tab a remote host adopted under a web-terminal- id', async () => {
    await startRunAction(WT_A, web, config([web]))
    const { tabId } = getRunActionRun(WT_A, 'web')!
    const adopted = `web-terminal-${tabId}`
    state.tabsByWorktree = { [WT_A]: [{ id: adopted }] }
    state.ptyIdsByTabId[adopted] = ['pty-adopted']
    for (const listener of mocks.subscribers) {
      listener(state, { tabsByWorktree: {} })
    }
    await vi.advanceTimersByTimeAsync(16_000)
    expect(getRunActionRun(WT_A, 'web')?.status).toBe('running')
    dispatchTerminalCommandFinishedEvent(WT_A, 2, adopted)
    expect(getRunActionRun(WT_A, 'web')).toMatchObject({ status: 'failed', exitCode: 2 })
  })

  it('merges local actions over orca.yaml ones and filters by host', async () => {
    const remoteOnly: OrcaRunAction = {
      id: 'cloud',
      name: 'Cloud',
      command: 'x',
      availableIn: ['remote']
    }
    const merged = mergeRunActions(
      { run: [web, remoteOnly], runMode: 'nonconcurrent' },
      { run: [{ ...web, command: 'mine' }] },
      'local'
    )
    expect(merged.actions).toEqual([{ ...web, command: 'mine' }])
    expect(merged.sharedIds.has('web')).toBe(false)
    expect(merged.scripts.runMode).toBe('nonconcurrent')
    mocks.checkRuntimeHooks.mockResolvedValue({ status: 'error', hooks: null })
    expect((await loadWorktreeRunActions(WT_A))?.actions).toEqual([])
  })
})
