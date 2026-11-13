import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { commitTerminalShutdownState } from '@/store/terminals/terminal-shutdown-state'
import {
  bindPanePtyExit,
  initializePanePtyExit
} from '../../pty-connection/lifecycle/pane-pty-exit'
import type { ConnectPanePtySession } from '../../pty-connection/connect-pane-pty-session'
import {
  LEAF_1,
  LEAF_2,
  createPane,
  createManager,
  createMockTransport
} from '../../pty-connection/test-fixtures/pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from '../../pty-connection/test-fixtures/pty-connection-test-deps'
import { mockPanePtyArgs } from '../../pty-connection/test-fixtures/pty-connection-test-connect-mock-pane'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../pty-connection/test-fixtures/pty-connection-test-environment'
import {
  applyHostWorktreeTerminalSleepState,
  deferPtyShutdownExit,
  settleDeferredPtyShutdownExits
} from './pty-shutdown-exit-deferral'
import { toRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  bufferPtyShutdownData,
  bufferPtyShutdownReplayData,
  isPtyDataHandlerShutdownPending,
  ptyDataHandlers,
  ptyReplayHandlers,
  ptyShutdownLifecycleHandlers
} from './pty-shutdown-data-suspension'

vi.mock('@/store', async () => {
  const { createTestStore } = await import('@/store/testing/app-store-test-fixture')
  return { useAppStore: createTestStore() }
})
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: () => {}
}))

const NOW = 1_800_000_000_000
const PANE = `tab-1:${LEAF_1}`
const SIBLING = `tab-1:${LEAF_2}`

async function placedExitSession() {
  await installTerminalTestGlobals()
  useAppStore.setState(useAppStore.getInitialState(), true)
  const tab = makeTab({ id: 'tab-1', worktreeId: 'wt-1' })
  useAppStore.setState({
    workspaceSessionReady: true,
    tabsByWorktree: { 'wt-1': [tab] },
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
        ptyIdsByLeafId: { [LEAF_1]: 'pty-1', [LEAF_2]: 'pty-2' }
      }
    },
    ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] }
  })
  const transport = createMockTransport('pty-1')
  const [pane, manager, deps] = mockPanePtyArgs(
    createPane(1),
    createManager(1),
    buildPaneConnectionDeps(useAppStore.getState, {
      isPtyShutdownPending: (id: string) => !!useAppStore.getState().pendingPtyShutdownIds[id],
      consumeSuppressedPtyExit: useAppStore.getState().consumeSuppressedPtyExit,
      setCacheTimerStartedAt: useAppStore.getState().setCacheTimerStartedAt,
      paneTransportsRef: { current: new Map([[1, transport]]) }
    })
  )
  // SAFETY: the exit installer uses the same partial session initialization as connectPanePty.
  const session = { pane, manager, deps } as ConnectPanePtySession
  Object.assign(session, {
    transport,
    cacheKey: PANE,
    runtimeEnvironmentId: null,
    processExitStateByPtyId: new Map(),
    resetRendererOrderedSeqForPtyExit: () => {},
    agentCompletionCoordinator: { dispose: () => {} },
    dropSideEffectFactConsumer: () => {},
    releaseHiddenRendererPtyDelivery: () => {},
    clearPanePtyFitBinding: () => {},
    clearExitedPanePtyLayoutBinding: () => {},
    getSleepingRecordForPane: () => null,
    hibernatedWakeTarget: null,
    hiddenAgentResumeHeldTarget: null,
    pendingHibernatedWakeTarget: null,
    lastTerminalInputAt: NOW
  })
  initializePanePtyExit(session)
  bindPanePtyExit(session)
  return { session, tab, transport }
}

it('keeps providerless Done through the committed deferred process exit until exact close', async () => {
  const { session, tab } = await placedExitSession()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  try {
    useAppStore
      .getState()
      .setAgentStatus(PANE, { state: 'done', agentType: 'claude', prompt: 'Finished' }, undefined, {
        stateStartedAt: NOW - 100
      })
    useAppStore
      .getState()
      .setAgentStatus(SIBLING, { state: 'working', agentType: 'codex', prompt: '' })
    useAppStore.setState({
      pendingPtyShutdownIds: { 'pty-1': 1, 'pty-2': 1 },
      acknowledgedAgentsByPaneKey: { [PANE]: NOW },
      activityClearedAtByPaneKey: { [PANE]: NOW - 50 },
      manuallyUnreadTurnsByPaneKey: { [PANE]: NOW - 75 },
      agentLaunchConfigByPaneKey: {
        [PANE]: { launchConfig: { agentArgs: '', agentEnv: {} }, identity: { agentType: 'claude' } }
      },
      cacheTimerByKey: { [PANE]: NOW }
    })
    useAppStore.getState().setPaneForegroundAgent(PANE, { agent: 'claude', shellForeground: false })
    session.onExit('pty-1', 0)
    useAppStore
      .getState()
      .setAgentStatus(
        PANE,
        { state: 'done', agentType: 'claude', prompt: 'Finished', paneSleep: { ptyId: 'pty-1' } },
        undefined,
        { stateStartedAt: NOW - 100 }
      )
    commitTerminalShutdownState({
      exitGuardPtyIds: ['pty-1', 'pty-2'],
      get: useAppStore.getState,
      set: useAppStore.setState,
      keepIdentifiers: true,
      shutdownReason: 'manual-sleep',
      sleepingAgentSessionRecords: {},
      sleepingPaneKeys: [PANE, SIBLING],
      tabs: [tab],
      worktreeId: 'wt-1'
    })
    expect(useAppStore.getState().agentStatusByPaneKey.projection.list('wt-1')).toMatchObject([
      { paneKey: PANE, state: 'done' }
    ])
    const state = useAppStore.getState()
    expect(state.agentStatusByPaneKey.get(PANE)).toMatchObject({
      stateStartedAt: NOW - 100,
      paneSleep: { ptyId: 'pty-1' }
    })
    expect(state.acknowledgedAgentsByPaneKey[PANE]).toBe(NOW)
    expect(state.activityClearedAtByPaneKey[PANE]).toBe(NOW - 50)
    expect(state.manuallyUnreadTurnsByPaneKey[PANE]).toBe(NOW - 75)
    expect(state.agentLaunchConfigByPaneKey[PANE]).toBeUndefined()
    expect(state.paneForegroundAgentByPaneKey[PANE]).toBeUndefined()
    expect(state.cacheTimerByKey[PANE]).toBeNull()
    expect(state.sleepingAgentSessionsByPaneKey[PANE]).toBeUndefined()
    state.dropAgentStatus(PANE, { paneRemoved: true })
    expect(useAppStore.getState().agentStatusByPaneKey.projection.list('wt-1')).toEqual([])
  } finally {
    await restoreTerminalTestGlobals()
  }
})

it('still removes ordinary unmarked Done on process exit', async () => {
  const { session } = await placedExitSession()
  try {
    useAppStore
      .getState()
      .setAgentStatus(PANE, { state: 'done', agentType: 'claude', prompt: 'Finished' })
    session.onExit('pty-1', 0)
    expect(useAppStore.getState().agentStatusByPaneKey.projection.list('wt-1')).toEqual([])
  } finally {
    await restoreTerminalTestGlobals()
  }
})

it('does not let a deferred old exit clear a rebound process on the same transport', async () => {
  const { session, transport } = await placedExitSession()
  try {
    useAppStore.setState({ pendingPtyShutdownIds: { 'pty-1': 1 } })
    session.onExit('pty-1', 0)
    transport.getPtyId.mockReturnValue('pty-new')
    useAppStore
      .getState()
      .setAgentStatus(PANE, { state: 'working', agentType: 'codex', prompt: 'New turn' })
    useAppStore.getState().setPaneForegroundAgent(PANE, { agent: 'codex', shellForeground: false })
    useAppStore.setState({ pendingPtyShutdownIds: {}, cacheTimerByKey: { [PANE]: NOW } })
    settleDeferredPtyShutdownExits(['pty-1'], 'committed')
    expect(useAppStore.getState().agentStatusByPaneKey.get(PANE)?.state).toBe('working')
    expect(useAppStore.getState().paneForegroundAgentByPaneKey[PANE]?.agent).toBe('codex')
    expect(useAppStore.getState().cacheTimerByKey[PANE]).toBe(NOW)
  } finally {
    await restoreTerminalTestGlobals()
  }
})

it('keeps an accepted paired Done whose physical PTY differs from the renderer handle', async () => {
  const { session, transport } = await placedExitSession()
  try {
    const remotePtyId = toRemoteRuntimePtyId('terminal-1', 'env-1')
    transport.getPtyId.mockReturnValue(remotePtyId)
    session.runtimeEnvironmentId = 'env-1'
    useAppStore.getState().setAgentStatus(PANE, {
      state: 'done',
      agentType: 'claude',
      prompt: 'Finished',
      paneSleep: { ptyId: 'host-physical-pty' }
    })
    session.onExit(remotePtyId, 0, { preserveRendererBinding: true })
    expect(useAppStore.getState().agentStatusByPaneKey.projection.list('wt-1')).toMatchObject([
      { paneKey: PANE, state: 'done' }
    ])
    useAppStore.getState().removeAgentStatus(PANE)
    expect(useAppStore.getState().agentStatusByPaneKey.projection.list('wt-1')).toEqual([])
  } finally {
    await restoreTerminalTestGlobals()
  }
})

it('autonomously rolls back a pending host sleep when its outcome is missed', () => {
  vi.useFakeTimers()
  const remotePtyId = toRemoteRuntimePtyId('terminal-timeout', 'env-timeout')
  const dataHandler = vi.fn()
  const replayHandler = vi.fn()
  const lifecycle = { pause: vi.fn(), rollback: vi.fn(), commit: vi.fn() }
  const exitHandler = vi.fn()
  try {
    vi.setSystemTime(new Date('2026-07-21T00:00:00Z'))
    ptyDataHandlers.set(remotePtyId, dataHandler)
    ptyReplayHandlers.set(remotePtyId, replayHandler)
    ptyShutdownLifecycleHandlers.set(remotePtyId, lifecycle)
    deferPtyShutdownExit(remotePtyId, exitHandler)

    applyHostWorktreeTerminalSleepState('env-timeout', {
      type: 'worktreeTerminalSleepState',
      worktreeId: 'repo::worktree',
      generation: 51,
      phase: 'started',
      ptyIds: ['pty-timeout'],
      terminalHandles: ['terminal-timeout']
    })
    expect(bufferPtyShutdownData(remotePtyId, 'live output')).toBe(true)
    expect(bufferPtyShutdownReplayData(remotePtyId, 'replay output')).toBe(true)

    vi.advanceTimersByTime(30_001)

    expect(lifecycle.rollback).toHaveBeenCalledOnce()
    expect(isPtyDataHandlerShutdownPending(remotePtyId)).toBe(false)
    expect(dataHandler).toHaveBeenCalledWith('live output', undefined)
    expect(replayHandler).toHaveBeenCalledWith('replay output')
    expect(exitHandler).toHaveBeenCalledWith('rolled-back')
  } finally {
    ptyDataHandlers.delete(remotePtyId)
    ptyReplayHandlers.delete(remotePtyId)
    ptyShutdownLifecycleHandlers.delete(remotePtyId)
    vi.useRealTimers()
  }
})
