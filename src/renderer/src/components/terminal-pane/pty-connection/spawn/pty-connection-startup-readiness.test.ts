import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  LEAF_1,
  LEAF_2,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  bindPaneAgentTitleMocks,
  type PtyConnectionAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import { TerminalStartupAttempt } from '@/store/terminals/terminal-startup-attempt'
import type { AppState } from '@/store/types'
import type { TerminalPaneStart } from '@/store/terminals/terminal-state'
import type { PanePtyBinding } from '../pane-pty-binding'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { connectMockPanePty } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import { PANE_NOT_LIVE_ERROR } from '../../../../../../shared/pane-attach-only-view'

vi.mock('../../../../../../shared/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: false
}))

type StartupState = StoreState & {
  terminalStartupRestorationReady: boolean
  terminalStartupAttempt?: TerminalStartupAttempt
}
let state: StartupState
let subscribers: ((next: StoreState) => void)[] = []
let transports: MockTransport[] = []
let bindings: PanePtyBinding[] = []

function publish(patch: Partial<StartupState>): void {
  state = { ...state, ...patch }
  for (const listener of subscribers) {
    listener(state)
  }
}

function retainedStart(leafId: string, status: 'starting' | 'failed'): TerminalPaneStart {
  return {
    status,
    reason: 'The shell could not be started.',
    retainedTerminalStart: {
      worktreeId: 'wt-1',
      runtimeId: 'runtime-local',
      executionHostId: 'local',
      tabId: 'tab-1',
      leafId,
      bindingGeneration: 0,
      startSequence: 1,
      status,
      reason: 'The shell could not be started.'
    }
  }
}

async function mount(
  paneId: number,
  transport: MockTransport,
  explicitPaneRestart = false,
  overrides: Record<string, unknown> = {}
) {
  transports.push(transport)
  const deps = buildPaneConnectionDeps(() => state, { explicitPaneRestart, ...overrides })
  const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
    '@/lib/agent-status/aggregation/worktree-agent-status'
  )
  bindPaneAgentTitleMocks(deps, agentTitleMocks)
  const binding = await connectMockPanePty(createPane(paneId), createManager(2), deps)
  bindings.push(binding)
  await flushAsyncTicks()
  return { binding, deps }
}

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  subscribers = []
  transports = []
  bindings = []
  state = {
    ...createInitialStoreState(() => state),
    terminalStartupRestorationReady: false,
    tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {
      'tab-1': {
        root: {
          type: 'split',
          direction: 'horizontal',
          ratio: 0.5,
          first: { type: 'leaf', leafId: LEAF_1 },
          second: { type: 'leaf', leafId: LEAF_2 }
        },
        activeLeafId: LEAF_1,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_1]: 'pty-saved' }
      }
    }
  }
  const attempt = new TerminalStartupAttempt()
  attempt.capture(state as unknown as AppState)
  state.terminalStartupAttempt = attempt
  bindPtyConnectionTestMocks({
    getState: () => state,
    getTransportQueue: () => transports,
    getTransportOptions: () => [],
    getStoreSubscribers: () => subscribers,
    setStoreSubscribers: (next) => {
      subscribers = next
    }
  })
  await installTerminalTestGlobals()
})

afterEach(async () => {
  for (const binding of bindings) {
    binding.dispose()
  }
  await restoreTerminalTestGlobals()
})

it('allows a saved attach while startup is unknown, holds its missing fallback and an unbound mount, and leaves Restart explicit', async () => {
  const saved = createMockTransport()
  saved.connect.mockImplementation(async (options) => {
    options.callbacks?.onError?.(PANE_NOT_LIVE_ERROR)
    return undefined
  })
  const { deps: savedDeps } = await mount(1, saved)
  expect(saved.connect.mock.calls).toEqual([
    [expect.objectContaining({ sessionId: 'pty-saved', attachOnlyView: true })]
  ])

  const unbound = createMockTransport()
  const { binding: unboundBinding, deps: unboundDeps } = await mount(2, unbound)
  expect(unbound.connect).not.toHaveBeenCalled()
  expect(unbound.attach).not.toHaveBeenCalled()

  publish({
    terminalPaneStartsByPaneKey: {
      [`tab-1:${LEAF_1}`]: retainedStart(LEAF_1, 'starting'),
      [`tab-1:${LEAF_2}`]: retainedStart(LEAF_2, 'starting')
    }
  })
  state.terminalStartupAttempt?.settle('tab-1', LEAF_1)
  state.terminalStartupAttempt?.settle('tab-1', LEAF_2)
  publish({
    terminalStartupRestorationReady: true,
    terminalPaneStartsByPaneKey: {
      [`tab-1:${LEAF_1}`]: retainedStart(LEAF_1, 'failed'),
      [`tab-1:${LEAF_2}`]: retainedStart(LEAF_2, 'failed')
    }
  })
  await flushAsyncTicks()
  expect(savedDeps.onPtyErrorRef.current).toHaveBeenCalledWith(
    1,
    'The terminal could not start: The shell could not be started.'
  )
  expect(unboundDeps.onPtyErrorRef.current).toHaveBeenCalledWith(
    2,
    'The terminal could not start: The shell could not be started.'
  )
  expect(saved.connect.mock.calls).toEqual([
    [expect.objectContaining({ sessionId: 'pty-saved', attachOnlyView: true })]
  ])
  expect(unbound.connect).not.toHaveBeenCalled()

  unboundBinding.dispose()
  bindings = bindings.filter((binding) => binding !== unboundBinding)
  publish({ terminalStartupRestorationReady: false })
  const restarted = createMockTransport()
  await mount(2, restarted, true)
  expect(restarted.connect).toHaveBeenCalledWith(
    expect.objectContaining({ resumeSpawnIntent: 'user-resume' })
  )
  publish({ terminalStartupRestorationReady: true, terminalPaneStartsByPaneKey: {} })
  await flushAsyncTicks()
  expect(saved.connect.mock.calls).toEqual([
    [expect.objectContaining({ sessionId: 'pty-saved', attachOnlyView: true })]
  ])
  expect(unbound.connect).not.toHaveBeenCalled()
})

it('does not gate a newly created leaf in a restored tab when general startup degraded', async () => {
  // The cohort originally contained only L1; L2 is a later user split.
  const current = state.terminalLayoutsByTabId!['tab-1']!
  state.terminalLayoutsByTabId = { 'tab-1': { ...current, root: { type: 'leaf', leafId: LEAF_1 } } }
  state.terminalStartupAttempt = new TerminalStartupAttempt()
  state.terminalStartupAttempt.capture(state as unknown as AppState)
  publish({ terminalStartupRestorationReady: true, terminalLayoutsByTabId: { 'tab-1': current } })
  const fresh = createMockTransport()
  await mount(2, fresh)
  expect(fresh.connect).toHaveBeenCalledOnce()
  expect(fresh.attach).not.toHaveBeenCalled()
  const old = createMockTransport()
  old.connect.mockImplementation(async (options) => {
    options.callbacks?.onError?.(PANE_NOT_LIVE_ERROR)
    return undefined
  })
  await mount(1, old)
  expect(old.connect.mock.calls).toEqual([
    [expect.objectContaining({ sessionId: 'pty-saved', attachOnlyView: true })]
  ])
})

it('lets a new direct SSH action connect while the restored local cohort remains unknown', async () => {
  const worktreeId = 'ssh-repo::/remote/project'
  publish({
    terminalStartupRestorationReady: true,
    repos: [
      ...state.repos,
      { id: 'ssh-repo', connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }
    ],
    worktreesByRepo: {
      ...state.worktreesByRepo,
      'ssh-repo': [
        { id: worktreeId, repoId: 'ssh-repo', path: '/remote/project', hostId: 'ssh:ssh-1' }
      ]
    },
    sshConnectionStates: new Map([['ssh-1', { status: 'disconnected' }]]),
    tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: [{ id: 'ssh-tab', ptyId: null }] },
    terminalLayoutsByTabId: {
      ...state.terminalLayoutsByTabId,
      'ssh-tab': {
        root: { type: 'leaf', leafId: LEAF_2 },
        activeLeafId: LEAF_2,
        expandedLeafId: null
      }
    }
  })
  const fresh = createMockTransport()
  await mount(2, fresh, false, { worktreeId, tabId: 'ssh-tab', cwd: '/remote/project' })
  expect(window.api.ssh.connect).toHaveBeenCalledExactlyOnceWith({
    targetId: 'ssh-1',
    automatic: true
  })
  expect(fresh.connect).not.toHaveBeenCalled()
  expect(fresh.attach).not.toHaveBeenCalled()
  expect(state.terminalStartupAttempt?.isUnknown('wt-1', 'tab-1', LEAF_2)).toBe(true)
})
