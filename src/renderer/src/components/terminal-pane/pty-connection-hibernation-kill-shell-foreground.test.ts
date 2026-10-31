import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let createdTransportOptions: Record<string, unknown>[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

function createDeps(overrides: Record<string, unknown> = {}) {
  return buildPaneConnectionDeps(() => mockStoreState, overrides)
}

// A hibernation kill ends the agent before the PTY, so the pane sees its own shell for a moment.
describe('shell showing through a hibernation kill', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    createdTransportOptions = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    const pendingPtyShutdownIds: Record<string, number> = {}
    mockStoreState.isPtyShutdownPending = (ptyId) => (pendingPtyShutdownIds[ptyId] ?? 0) > 0
    bindPtyConnectionTestMocks({
      getState: () => mockStoreState,
      getTransportQueue: () => transportFactoryQueue,
      getTransportOptions: () => createdTransportOptions,
      getStoreSubscribers: () => storeSubscribers,
      setStoreSubscribers: (subscribers) => {
        storeSubscribers = subscribers
      }
    })
    await installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  function capturePhysicalSource(ptyId: string) {
    const sources = globalThis.terminalConnectionTestDelivery?.sidecars.get(ptyId)
    expect(sources?.size).toBe(1)
    const source = sources && [...sources][0]
    if (!source) {
      throw new Error('Expected the admitted execution raw-data subscription')
    }
    let seq = 0
    return {
      source,
      deliver: (bytes: string) => {
        seq += bytes.length
        source(bytes, { seq, rawLength: bytes.length })
      }
    }
  }

  async function connectHibernatingPane(suppressExit: boolean) {
    vi.useFakeTimers()
    const { connectPanePty } = await import('./pty-connection')
    vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
    const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
    const ptyId = 'pty-hibernating'
    const transport = createMockTransport(ptyId)
    transport.connect.mockImplementation(async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
      dataCallbackRef.current = callbacks.onData ?? null
      return { id: ptyId }
    })
    transportFactoryQueue.push(transport)
    const paneKey = makePaneKey('tab-1', LEAF_1)
    const args = mockPanePtyArgs(
      createPane(1),
      createManager(1),
      createDeps({
        isVisibleRef: { current: false },
        consumeSuppressedPtyExit: vi.fn((id: string) => {
          const suppressed = mockStoreState.suppressedPtyExitIds[id] === true
          delete mockStoreState.suppressedPtyExitIds[id]
          return suppressed
        })
      })
    )
    connectPanePty(...args)
    await vi.advanceTimersByTimeAsync(20)
    await flushAsyncTicks()
    const { getTerminalSemanticResident, observeTerminalSemanticResidentExit } =
      await import('./terminal-semantic-residents')
    const resident = getTerminalSemanticResident(ptyId)
    if (!resident) {
      throw new Error('Expected connect/admission to publish E before effects')
    }
    expect(resident.isLive).toBe(true)
    expect(resident.identity.ptyId).toBe(ptyId)
    expect(dataCallbackRef.current).toEqual(expect.any(Function))
    const oldSource = capturePhysicalSource(ptyId)
    let currentSource = oldSource
    mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
      launchConfig: { agentArgs: '', agentEnv: {} },
      identity: { agentType: 'claude' }
    }
    // Hibernation writes the wake record and suppresses the exit before it kills the PTY.
    const record: SleepingAgentSessionRecord = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'sess-hibernating' },
      prompt: '',
      state: 'done',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = record
    if (suppressExit) {
      mockStoreState.suppressedPtyExitIds[ptyId] = true
    }
    return {
      paneKey,
      record,
      resident,
      oldSource,
      captureWrites: () => ({
        foreground: mockStoreState.paneForegroundAgentByPaneKey[paneKey],
        titles: structuredClone(mockStoreState.runtimePaneTitlesByTabId),
        foregroundWrites: mockStoreState.setPaneForegroundAgent.mock.calls.slice(),
        foregroundClears: mockStoreState.clearPaneForegroundAgent.mock.calls.slice(),
        titleWrites: mockStoreState.setRuntimePaneTitle.mock.calls.slice(),
        tabTitleWrites: mockStoreState.updateTabTitle.mock.calls.slice(),
        recordClears: mockStoreState.clearSleepingAgentSession.mock.calls.slice()
      }),
      finishCommand: () => {
        const currentId = transport.getPtyId()
        const current = currentId ? getTerminalSemanticResident(currentId) : undefined
        if (!current?.isLive || !dataCallbackRef.current) {
          throw new Error('Expected current admitted physical E before command-finished bytes')
        }
        currentSource.deliver('\x1b]133;D;0\x07\x1b]133;A\x07')
      },
      rebindPty: (id: string | null) => {
        if (id === null) {
          transport.disconnect()
          return
        }
        if (id === ptyId) {
          expect(transport.getPtyId()).toBe(ptyId)
          return
        }
        transport.attach({ existingPtyId: id, callbacks: {} })
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn
        if (typeof onPtySpawn !== 'function') {
          throw new Error('Expected physical spawn binding callback')
        }
        onPtySpawn(id)
        const successor = getTerminalSemanticResident(id)
        if (!successor) {
          throw new Error('Expected positive attach to admit the successor')
        }
        expect(successor).not.toBe(resident)
        expect(successor.isLive).toBe(true)
        currentSource = capturePhysicalSource(id)
        expect(currentSource.source).not.toBe(oldSource.source)
        expect(resident.isLive).toBe(false)
        expect(mockStoreState.terminalLayoutsByTabId['tab-1'].ptyIdsByLeafId?.[LEAF_1]).toBe(id)
        return successor
      },
      exitPty: () => {
        observeTerminalSemanticResidentExit(ptyId, 0, resident.identity.incarnationId ?? undefined)
        expect(resident.isLive).toBe(false)
        expect(getTerminalSemanticResident(ptyId)).toBeUndefined()
        const onPtyExit = createdTransportOptions[0]?.onPtyExit
        if (typeof onPtyExit !== 'function') {
          throw new Error('Expected physical exit presentation callback')
        }
        onPtyExit(ptyId)
      }
    }
  }

  it('keeps the wake record while the kill is in flight', async () => {
    const pane = await connectHibernatingPane(true)

    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.paneForegroundAgentByPaneKey[pane.paneKey]).toEqual({
      agent: null,
      shellForeground: true,
      context: {
        execution: expect.any(Function),
        endpoint: 'local',
        executionHost: 'local',
        ptyId: 'pty-hibernating',
        incarnationId: null,
        worktreeId: 'wt-1',
        environmentId: null
      }
    })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toMatchObject({
      providerSession: { id: 'sess-hibernating' }
    })
  })

  it.each(['pty-hibernating', null])(
    'preserves the wake record when a pending confirmation settles with PTY %s',
    async (boundPtyId) => {
      const pane = await connectHibernatingPane(true)
      const foreground = createDeferred<string | null>()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValueOnce(foreground.promise)

      pane.finishCommand()
      await vi.advanceTimersByTimeAsync(350)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledExactlyOnceWith(
        'pty-hibernating'
      )
      pane.exitPty()
      pane.rebindPty(boundPtyId)
      await flushAsyncTicks()
      expect(mockStoreState.suppressedPtyExitIds).toEqual({})
      expect(pane.resident.isLive).toBe(false)
      expect(mockStoreState.paneForegroundAgentByPaneKey[pane.paneKey]).toBeUndefined()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBe(pane.record)
      const successor = pane.rebindPty('pty-successor')
      if (!successor) {
        throw new Error('Expected a positively admitted successor')
      }
      const beforeLateResult = pane.captureWrites()
      foreground.resolve('zsh')
      pane.oldSource.deliver('\x1b]133;D;0\x07\x1b]133;A\x07')
      await flushAsyncTicks()

      expect(pane.captureWrites()).toEqual(beforeLateResult)
      expect(successor.isLive).toBe(true)
      const { getTerminalSemanticResident } = await import('./terminal-semantic-residents')
      expect(getTerminalSemanticResident('pty-hibernating')).toBeUndefined()
      expect(getTerminalSemanticResident('pty-successor')).toBe(successor)
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledExactlyOnceWith(
        'pty-hibernating'
      )
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBe(pane.record)
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toMatchObject({
        providerSession: { id: 'sess-hibernating' }
      })
    }
  )

  it('clears the record once another PTY is bound in place of the hibernated one', async () => {
    const pane = await connectHibernatingPane(true)

    pane.exitPty()
    await flushAsyncTicks()
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    // A restart binds a new PTY without consuming the armed wake.
    const successor = pane.rebindPty('pty-restarted')
    expect(successor?.isLive).toBe(true)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBe(pane.record)
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
  })

  it('still clears a record beside a PTY that is not being hibernated', async () => {
    const pane = await connectHibernatingPane(false)

    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
  })

  it('does not protect a replacement record with the old wake target', async () => {
    const pane = await connectHibernatingPane(true)
    const foreground = createDeferred<string | null>()
    vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValueOnce(foreground.promise)
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)
    expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledExactlyOnceWith(
      'pty-hibernating'
    )

    pane.exitPty()
    await flushAsyncTicks()
    const replacement = { ...pane.record, updatedAt: 2 }
    mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey] = replacement
    const beforeOldBytes = pane.captureWrites()
    foreground.resolve('zsh')
    pane.oldSource.deliver('\x1b]133;D;0\x07\x1b]133;A\x07')
    await vi.advanceTimersByTimeAsync(350)
    expect(pane.captureWrites()).toEqual(beforeOldBytes)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBe(replacement)
    expect(replacement).toEqual({ ...pane.record, updatedAt: 2 })
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    const successor = pane.rebindPty('pty-restarted')
    expect(successor?.isLive).toBe(true)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBe(replacement)
    expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)

    expect(vi.mocked(window.api.pty.confirmForegroundProcess).mock.calls).toEqual([
      ['pty-hibernating'],
      ['pty-restarted']
    ])
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
    expect(mockStoreState.sleepingAgentSessionsByPaneKey[pane.paneKey]).toBeUndefined()
    pane.finishCommand()
    await vi.advanceTimersByTimeAsync(350)
    expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledExactlyOnceWith(pane.paneKey)
    expect(successor?.isLive).toBe(true)
  })
})
