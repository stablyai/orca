import '../../../../../../main/daemon/pty-subprocess/testing/mock-descendant-sweep'
import { Socket } from 'node:net'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import {
  LEAF_2,
  createManager,
  createPane,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  bindPaneAgentTitleMocks,
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import { DaemonPtyAdapter } from '../../../../../../main/daemon/providers/adapter/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness
} from '../../../../../../main/daemon/providers/adapter/testing/daemon-pty-adapter-test-harness'
import { answerDaemonControlRequest } from '../../../../../../main/daemon/server/daemon-control-request'
import { answerDaemonHistoryRequest } from '../../../../../../main/daemon/server/daemon-history-requests'
import { HISTORY_READ_CONSUMERS } from '../../../../../../main/daemon/history/journal/terminal-history-read-admission'
import type { GetSnapshotRequest } from '../../../../../../main/daemon/protocol/daemon-rpc-contract'
import type { PtySpawnResult } from '../../../../../../main/providers/pty-provider-contract'
import type * as PtyTransportModule from '../../pty-transport/ipc/pty-transport'

type LiveTransport = ReturnType<typeof PtyTransportModule.createIpcPtyTransport>

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const SAVED_PTY = 'unverifiable-pty'
let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
let provider: DaemonPtyAdapter | undefined
let mockStoreState: StoreState
const transportQueue: MockTransport[] = []
const transportOptions: Record<string, unknown>[] = []

beforeEach(async () => {
  mockStoreState = createInitialStoreState(() => mockStoreState)
  bindPtyConnectionTestMocks({
    getState: () => mockStoreState,
    getTransportQueue: () => transportQueue,
    getTransportOptions: () => transportOptions,
    getStoreSubscribers: () => [],
    setStoreSubscribers: () => {}
  })
  await installTerminalTestGlobals()
})

afterEach(async () => {
  vi.useRealTimers()
  await provider?.disconnectOnly()
  provider?.dispose()
  harness?.adapter.dispose()
  await harness?.server.shutdown()
  if (harness) {
    rmSync(harness.dir, { recursive: true, force: true })
  }
  harness = undefined
  provider = undefined
  await restoreTerminalTestGlobals()
})

// The real IPC transport module, loaded once outside any test's timeout.
let actualTransport: typeof PtyTransportModule
beforeAll(async () => {
  actualTransport = await vi.importActual<typeof PtyTransportModule>(
    '../../pty-transport/ipc/pty-transport'
  )
})

/** The real IPC transport, created with the options connect-pane-pty passes it. */
function realIpcTransport(): { transport: MockTransport; live: () => LiveTransport } {
  let real: LiveTransport | undefined
  const live = (): LiveTransport =>
    (real ??= actualTransport.createIpcPtyTransport(transportOptions.at(-1) ?? {}))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: forwards every member to the real transport.
  const transport = new Proxy({} as MockTransport, {
    get: (_, key) => {
      const value: unknown = Reflect.get(live(), key)
      return typeof value === 'function' ? value.bind(live()) : value
    },
    set: (_, key, value) => Reflect.set(live(), key, value)
  })
  return { transport, live }
}

/** Lets real socket I/O and the client's responsive deadlines advance under fake timers. */
async function advanceUntil(done: () => boolean, limitMs = 60_000): Promise<void> {
  for (let elapsed = 0; elapsed < limitMs && !done(); elapsed += 250) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await vi.advanceTimersByTimeAsync(250)
  }
  expect(done()).toBe(true)
}

describe('warm attach while deep-history capacity is full', () => {
  // NB1: an abandoned warm attach timed out as a generic failure and the pane started fresh.
  it('keeps the saved pane, the live process and its input, then Retry attaches it', async () => {
    let spawned = 0
    const child = createMockSubprocess()
    harness = await startDaemonAdapterHarness(
      () => {
        spawned += 1
        return child
      },
      {},
      { hostHistory: true }
    )
    provider = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath,
      historyPath: join(harness.dir, 'history')
    })
    const original = await provider.spawn({ sessionId: SAVED_PTY, cols: 80, rows: 24, cwd: '/tmp' })
    child._simulateData('WARM_ROW\r\n')

    // Fill every deep consumer with a reply whose write never settles.
    const held: (() => void)[] = []
    const socket = Object.assign(new Socket(), {
      write: (_line: string, settle: () => void) => {
        held.push(settle)
        return false
      }
    })
    for (let index = 0; index < HISTORY_READ_CONSUMERS; index += 1) {
      const request: GetSnapshotRequest = {
        id: `held-${index}`,
        type: 'getSnapshot',
        payload: { sessionId: SAVED_PTY, scrollbackRows: 5000 }
      }
      await answerDaemonControlRequest(
        socket,
        request,
        () => answerDaemonHistoryRequest(harness!.server.host, request, socket),
        () => {}
      )
    }
    expect(held).toHaveLength(HISTORY_READ_CONSUMERS)

    // Main's IPC: renderer spawn reaches the provider; its errors arrive as Electron wraps them.
    const attaches: (PtySpawnResult | Error)[] = []
    window.api.pty.spawn = vi.fn<typeof window.api.pty.spawn>(
      async (args: { sessionId?: string; cols: number; rows: number }) => {
        try {
          const result = await provider!.spawn({
            sessionId: args.sessionId,
            cols: args.cols,
            rows: args.rows,
            cwd: '/tmp'
          })
          attaches.push(result)
          return result
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error))
          attaches.push(failure)
          throw new Error(`Error invoking remote method 'pty:spawn': Error: ${failure.message}`)
        }
      }
    )
    window.api.pty.write = vi.fn((id: string, data: string) => provider!.write(id, data))
    Object.assign(window.api.pty, {
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
      onReplay: vi.fn(() => () => {}),
      onWriteUnavailable: vi.fn(() => () => {}),
      onDeliveryResyncRequest: vi.fn(() => () => {})
    })

    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: SAVED_PTY }] },
      ptyIdsByTabId: { 'tab-1': [SAVED_PTY] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_2]: SAVED_PTY }
        }
      }
    }
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: { [LEAF_2]: SAVED_PTY }
    })
    const { transport, live } = realIpcTransport()
    transportQueue.push(transport)
    const { connectPanePty } = await import('../connect-pane-pty')
    const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
      '@/lib/agent-status/aggregation/worktree-agent-status'
    )

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    connectPanePty(
      ...mockPanePtyArgs(
        createPane(2),
        createManager(2),
        bindPaneAgentTitleMocks(deps, agentTitleMocks)
      )
    )
    // The refused attach gets no reply; the request, its cancel and the late-reply grace settle.
    await advanceUntil(() => attaches.length === 1)
    await advanceUntil(
      () => vi.mocked(window.api.pty.clearPendingPaneSerializer).mock.calls.length > 0
    )
    expect(attaches[0]).toBeInstanceOf(Error)
    expect(held).toHaveLength(HISTORY_READ_CONSUMERS)
    expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
    expect(deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(mockStoreState.terminalLayoutsByTabId?.['tab-1']?.ptyIdsByLeafId).toEqual({
      [LEAF_2]: SAVED_PTY
    })
    expect(spawned).toBe(1)
    expect(child.kill).not.toHaveBeenCalled()
    // The existing viewer was never displaced: its input still reaches the same process.
    provider.write(SAVED_PTY, 'old-view-input')
    await advanceUntil(() => child.write.mock.calls.some(([data]) => data === 'old-view-input'))

    // Capacity returns; the existing Retry reattaches the same terminal.
    held.shift()!()
    expect(live().retryRecovery?.()).toBe(true)
    await advanceUntil(() => attaches.length === 2)
    const retried = attaches[1]
    if (!retried || retried instanceof Error) {
      throw new Error(`Retry did not attach: ${String(retried)}`)
    }
    expect(retried.id).toBe(SAVED_PTY)
    expect(retried.incarnationId).toBe(original.incarnationId)
    expect(JSON.stringify(retried.snapshot)).toContain('WARM_ROW')
    expect(spawned).toBe(1)
    live().sendInput('typed-once', 'driving')
    await advanceUntil(() => child.write.mock.calls.some(([data]) => data === 'typed-once'))
    expect(child.write.mock.calls.filter(([data]) => data === 'typed-once')).toHaveLength(1)
    expect(child.kill).not.toHaveBeenCalled()
  }, 120_000)
})
