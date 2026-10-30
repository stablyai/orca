import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { MockStoreState } from '../../src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher.test'
import { createInitialStoreState } from '../../src/renderer/src/components/terminal-pane/pty-connection-test-store-fixtures'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../../src/renderer/src/components/terminal-pane/agent-task-complete-policy'

const PTY_ID = 'pty-parked-1'
const TAB_ID = 'tab-1'
const WORKTREE_ID = 'repo-1::/tmp/wt-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_ID = 1
const dispatchTerminalNotification = vi.fn()
let state: MockStoreState
function createStore(): MockStoreState {
  return {
    ...createInitialStoreState(() => state),
    tabsByWorktree: { [WORKTREE_ID]: [{ id: TAB_ID, ptyId: PTY_ID }] },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf' as const, leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    },
    ptyIdsByTabId: { [TAB_ID]: [PTY_ID] },
    isPtyShutdownPending: () => false,
    settings: {
      theme: 'system' as const,
      promptCacheTimerEnabled: true,
      experimentalTerminalAttention: false,
      terminalMainSideEffectAuthority: false,
      notifications: { enabled: true, agentTaskComplete: true }
    },
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabTitle: vi.fn(),
    markTerminalBell: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    observeTerminalGitHubPullRequestLink: vi.fn(),
    agentStatusByPaneKey: {},
    paneForegroundAgentByPaneKey: {}
  }
}
vi.mock('@/store', () => ({
  useAppStore: { getState: () => state, subscribe: vi.fn(() => () => {}) }
}))
vi.mock('../../src/renderer/src/components/terminal-pane/use-notification-dispatch', () => ({
  dispatchTerminalNotification
}))
vi.mock('@/lib/terminal-theme', () => ({ getSystemPrefersDark: () => true }))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  dispatchTerminalNotification.mockClear()
  state = createStore()
  vi.stubGlobal('window', {
    api: {
      pty: {
        onData: vi.fn(() => () => {}),
        onReplay: vi.fn(() => () => {}),
        onExit: vi.fn(() => () => {}),
        ackData: vi.fn(),
        hasPty: vi.fn().mockResolvedValue(true),
        inspectProcess: vi
          .fn()
          .mockResolvedValue({ foregroundProcess: null, hasChildProcesses: false }),
        confirmForegroundProcess: vi.fn().mockResolvedValue(null),
        getForegroundProcess: vi.fn().mockResolvedValue(null),
        hasChildProcesses: vi.fn().mockResolvedValue(false)
      }
    }
  })
})
afterEach(async () => {
  const handler =
    await import('../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler')
  handler._resetTerminalSideEffectFactConsumersForTest()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
async function startWatcher() {
  const { startParkedTerminalByteWatcher } =
    await import('../../src/renderer/src/components/terminal-pane/parked-terminal-byte-watcher')
  Object.assign(window.api.pty, { write: vi.fn() })
  return {
    dispose: startParkedTerminalByteWatcher({
      ptyId: PTY_ID,
      tabId: TAB_ID,
      worktreeId: WORKTREE_ID,
      leafId: LEAF_ID,
      paneId: PANE_ID
    })
  }
}

it('delivers the first capable live bell through daemon installation, runtime projection and the resident store', async () => {
  const { Socket } = await import('node:net')
  const { DaemonStreamDataBatcher } =
    await import('../../src/main/daemon/daemon-stream-data-batcher')
  const { DaemonTransientReader } = await import('../../src/main/daemon/daemon-transient-reader')
  const { SessionOutputPlane } = await import('../../src/main/daemon/session-output-plane')
  const { OrcaRuntimeService } = await import('../../src/main/runtime/orca-runtime')
  const handler =
    await import('../../src/renderer/src/components/terminal-pane/terminal-side-effect-facts-handler')
  state.settings = {
    ...state.settings,
    terminalMainSideEffectAuthority: true
  }
  Object.assign(window.api.pty, { hasPty: vi.fn().mockResolvedValue(false) })
  const { dispose } = await startWatcher()
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalSideEffects: handler.dispatchTerminalSideEffectBatch
  })
  runtime.setPtyController({
    spawn: vi.fn(),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        title: 'Terminal',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: TAB_ID,
        worktreeId: WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: PANE_ID,
        ptyId: PTY_ID
      }
    ]
  })
  const socket = new Socket()
  let deep = 256 * 1024
  Object.defineProperty(socket, 'writableLength', { get: () => deep })
  const reader = new DaemonTransientReader((event) => {
    if (event.event === 'terminalObservation') {
      runtime.applyTerminalTransientObservation(PTY_ID, event.incarnationId, event.payload)
    }
  })
  vi.spyOn(socket, 'write').mockImplementation((...args: unknown[]) => {
    reader.accept(JSON.parse(String(args[0])))
    return deep === 0
  })
  const batcher = new DaemonStreamDataBatcher(() => ({
    streamSocket: socket,
    streamFraming: 'ndjson'
  }))
  const plane = new SessionOutputPlane({ cols: 80, rows: 24, incarnationId: 'physical' })
  try {
    plane.emit({ data: '\x07', rawStartSeq: 0, rawEndSeq: 1, transformed: false })
    batcher.enqueue('client', PTY_ID, 'x'.repeat(64 * 1024))
    plane.attachClient({
      transients: batcher.bindTransients('client', PTY_ID),
      onData: (data) => batcher.enqueue('client', PTY_ID, data),
      onExit: () => {}
    })
    plane.emit({ data: '\x07', rawStartSeq: 1, rawEndSeq: 2, transformed: false })
    batcher.flush('client')
    expect(state.markTerminalBell).not.toHaveBeenCalled()
    deep = 0
    batcher.flush('client')
    expect(state.markTerminalBell).toHaveBeenCalledOnce()
    const resident = handler.getTerminalSemanticResident(PTY_ID)
    expect(resident?.identity.incarnationId).toBe('physical')
    dispose()
    await vi.advanceTimersByTimeAsync(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS)
    expect(dispatchTerminalNotification).toHaveBeenCalledOnce()
    expect(handler.getTerminalSemanticResident(PTY_ID)).toBe(resident)
  } finally {
    reader.dispose()
    plane.markDisposed()
    plane.disposeEmulator()
    batcher.clear()
    socket.destroy()
    runtime.onPtyExit(PTY_ID, 0)
    dispose()
  }
})
