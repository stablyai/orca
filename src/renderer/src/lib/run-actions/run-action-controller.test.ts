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
vi.mock('@/lib/ensure-hooks-confirmed', () => ({
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
const { installRunActionEvents, armAutoRunAfterSetup } = await import('./run-action-events')
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

  it('forgets a run when its terminal is closed', async () => {
    await startRunAction(WT_A, web, config([web]))
    const previous = { tabsByWorktree: { ...state.tabsByWorktree } }
    state.tabsByWorktree = { [WT_A]: [] }
    for (const listener of mocks.subscribers) {
      listener(state, previous)
    }
    expect(getRunActionRun(WT_A, 'web')).toBeNull()
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
