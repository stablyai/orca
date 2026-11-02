// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { DaemonClient } from '../../src/main/daemon/client'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { createPtyIpcSession } from '../../src/main/ipc/pty/session'
import { bindProviderListeners } from '../../src/main/ipc/pty/provider/bind-listeners'
import { unbindLocalProviderListeners } from '../../src/main/ipc/pty/provider/listener-lifecycle'
import { getLocalPtyProvider, setLocalPtyProvider } from '../../src/main/ipc/pty/provider/registry'
import { useAppStore } from '@/store'
import {
  createTestStore,
  seedStore,
  makeWorktree,
  makeTab
} from '@/store/slices/store-test-helpers'
import { getDefaultSettings } from '../../src/shared/constants'
import type { TerminalSideEffectBatch } from '../../src/shared/terminal-side-effect-facts'
import {
  dispatchTerminalSideEffectBatch,
  getTerminalSemanticResident,
  _resetTerminalSideEffectFactConsumersForTest
} from '../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../../src/renderer/src/components/terminal-pane/pty-connection-test-environment'
import { startParkedTerminalByteWatcher } from '../../src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher'

vi.mock('@/store', () => ({
  useAppStore: { getState: vi.fn(), subscribe: vi.fn(() => () => {}) }
}))
vi.mock('../../src/renderer/src/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification: vi.fn(() => true)
}))

afterEach(async () => {
  _resetTerminalSideEffectFactConsumersForTest()
  await restoreTerminalTestGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('retires a carried hidden v54 agent from replacement D/A bytes while filtering the old daemon D', async () => {
  vi.useFakeTimers()
  const store = createTestStore()
  vi.mocked(useAppStore.getState).mockImplementation(store.getState)
  await installTerminalTestGlobals()
  const ptyId = 'carried-v54-pty'
  const tabId = 'carried-tab'
  const leafId = '11111111-1111-4111-8111-111111111111'
  const paneKey = `${tabId}:${leafId}`
  const worktreeId = 'repo1::/tmp/carried'
  const tab = makeTab({ id: tabId, worktreeId, ptyId })
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), terminalMainSideEffectAuthority: true },
    worktreesByRepo: {
      repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/tmp/carried' })]
    },
    tabsByWorktree: { [worktreeId]: [tab] },
    ptyIdsByTabId: { [tabId]: [ptyId] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: { type: 'leaf', leafId },
        activeLeafId: leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leafId]: ptyId }
      }
    }
  })
  store.getState().setAgentStatus(paneKey, {
    state: 'done',
    agentType: 'claude',
    prompt: 'completed before attach'
  })
  const done = store.getState().agentStatusByPaneKey[paneKey]!
  store.getState().retainAgents([
    {
      entry: done,
      worktreeId,
      tab,
      agentType: 'claude',
      startedAt: done.stateStartedAt
    }
  ])
  const drop = vi.spyOn(store.getState(), 'dropAgentStatus')
  const batches: TerminalSideEffectBatch[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalSideEffects: (batch) => {
      batches.push(batch)
      dispatchTerminalSideEffectBatch(batch)
    }
  })
  runtime.registerPty(ptyId, worktreeId, null, { tabId, leafId, incarnationId: 'physical' })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [{ tabId, worktreeId, title: 'Terminal', activeLeafId: leafId, layout: null }],
    leaves: [{ tabId, worktreeId, leafId, paneRuntimeId: 1, ptyId }]
  })
  vi.mocked(window.api.pty.inspectProcess).mockResolvedValue({
    foregroundProcess: 'zsh',
    hasChildProcesses: false
  })
  const listeners: Parameters<DaemonClient['onEvent']>[0][] = []
  vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation((listener) => {
    listeners.push(listener)
    return () => {}
  })
  vi.spyOn(DaemonClient.prototype, 'ensureConnected').mockResolvedValue()
  vi.spyOn(DaemonClient.prototype, 'request').mockResolvedValue({
    size: { cols: 80, rows: 24 },
    isNew: false,
    pid: 4242,
    shellState: 'unsupported',
    snapshot: null,
    incarnationId: 'physical'
  })
  const notify = vi.spyOn(DaemonClient.prototype, 'notify').mockReturnValue(true)
  const adapter = new DaemonPtyAdapter({
    socketPath: '/tmp/pr31182-panel15-unused.sock',
    tokenPath: '/tmp/pr31182-panel15-unused.token',
    protocolVersion: 54
  })
  const priorProvider = getLocalPtyProvider()
  const session = createPtyIpcSession({ runtime })
  session.acceptPtyDataForRenderer = () => {}
  const source = { owner: {}, terminalState: false }
  const stopWatcher = startParkedTerminalByteWatcher({
    ptyId,
    tabId,
    worktreeId,
    leafId,
    paneId: 1
  })
  const emit = (event: Parameters<Parameters<DaemonClient['onEvent']>[0]>[0]) => {
    for (const listener of listeners) {
      listener(event, source)
    }
  }
  try {
    setLocalPtyProvider(adapter)
    bindProviderListeners(session)
    await adapter.attach(ptyId)
    await vi.advanceTimersByTimeAsync(0)
    adapter.setPtyBackgrounded(ptyId, true)
    expect(notify).toHaveBeenLastCalledWith('setSessionBackground', {
      sessionId: ptyId,
      background: false
    })
    // The new reader never saw this already-running interface's C.
    emit({ type: 'event', event: 'data', sessionId: ptyId, payload: { data: 'Claude prompt' } })
    expect(getTerminalSemanticResident(ptyId)?.isLive).toBe(true)
    emit({
      type: 'event',
      event: 'transientFact',
      sessionId: ptyId,
      payload: { kind: 'command-finished', exitCode: 0 }
    })
    expect(
      batches.flatMap((batch) => batch.facts).filter((f) => f.kind === 'command-finished')
    ).toHaveLength(0)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBe(done)
    // Synthetic shell control bytes; split D/A crosses provider chunks, not historical replay.
    for (const data of ['\x1b]133;D;0\x07\x1b]133;', 'A\x07']) {
      emit({ type: 'event', event: 'data', sessionId: ptyId, payload: { data } })
    }
    await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey[paneKey]).toBeUndefined()
    expect(drop).toHaveBeenCalledExactlyOnceWith(paneKey)
    expect(
      batches.flatMap((batch) => batch.facts).filter((f) => f.kind === 'command-finished')
    ).toHaveLength(1)
  } finally {
    stopWatcher()
    unbindLocalProviderListeners()
    setLocalPtyProvider(priorProvider)
    adapter.dispose()
    runtime.onPtyExit(ptyId, 0)
  }
})
