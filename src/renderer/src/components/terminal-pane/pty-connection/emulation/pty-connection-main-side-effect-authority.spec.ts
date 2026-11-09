import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS } from '../test-fixtures/pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'

export function registerPtyConnectionMainSideEffectAuthorityTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  function notifyStoreSubscribers(): void {
    for (const listener of storeSubscribers.slice()) {
      listener(mockStoreState)
    }
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.clearAllMocks()
      transportFactoryQueue = []
      createdTransportOptions = []
      storeSubscribers = []
      mockStoreState = createInitialStoreState(() => mockStoreState)
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

    describe('with main side-effect authority on', () => {
      const SIDE_EFFECT_PARSER_CALLBACKS = [
        'onTitleChange',
        'onBell',
        'onAgentBecameIdle',
        'onAgentBecameWorking',
        'onAgentExited'
      ] as const

      function enableMainAuthority(): void {
        mockStoreState.settings = {
          ...mockStoreState.settings,
          terminalMainSideEffectAuthority: true
        }
      }

      it('stops consuming facts after the pane binding is disposed', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks4 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        const deps = createDeps()
        const binding = connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks4)
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-2')

        binding.dispose()
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-2',
          seq: 1,
          facts: [{ kind: 'bell' }]
        })

        expect(deps.markTerminalBell).not.toHaveBeenCalled()
      })

      it('clears state without completion attention for stale-derived facts', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks6 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()

        const deps = createDeps()
        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-stale')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-stale',
          seq: 1,
          facts: [
            { kind: 'title', normalizedTitle: '⠋ Codex working', rawTitle: '⠋ Codex working' },
            { kind: 'agent-working' }
          ]
        })
        // Main's unthrottled 3s stale-title rewrite for a merely-paused agent.
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-stale',
          seq: 2,
          facts: [
            {
              kind: 'title',
              normalizedTitle: 'Codex',
              rawTitle: 'Codex',
              staleWorkingTitleClear: true
            },
            { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
          ]
        })

        expect(deps.setRuntimePaneTitle).toHaveBeenLastCalledWith('tab-1', 1, 'Codex')
        expect(deps.setCacheTimerStartedAt).toHaveBeenLastCalledWith(
          makePaneKey('tab-1', LEAF_1),
          null
        )
        vi.advanceTimersByTime(AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS * 2)
        expect(deps.dispatchNotification).not.toHaveBeenCalled()
        expect(deps.markTerminalBell).not.toHaveBeenCalled()
      })

      it('does not byte-scan PR links or OSC 133 — facts are the only consumer', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks9 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport()
        const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
        transport.connect.mockImplementation(
          async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
            capturedDataCallback.current = callbacks.onData ?? null
            return 'pty-authority-bytes'
          }
        )
        transportFactoryQueue.push(transport)
        const paneKey = makePaneKey('tab-1', LEAF_1)
        mockStoreState.agentStatusByPaneKey = {
          [paneKey]: {
            paneKey,
            state: 'done',
            prompt: 'hi',
            updatedAt: 1000,
            stateStartedAt: 1000,
            agentType: 'codex',
            stateHistory: []
          }
        }

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks9)
        )
        await flushAsyncTicks()
        expect(capturedDataCallback.current).not.toBeNull()

        capturedDataCallback.current?.('Created https://github.com/acme/orca/pull/42\r\n')
        capturedDataCallback.current?.('\x1b]133;D;130\x07prompt $ ')

        expect(mockStoreState.observeTerminalGitHubPullRequestLink).not.toHaveBeenCalled()
        expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
      })

      it('rejects Command Code facts when Claude owns the pane', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks11 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const claudeStatus = {
          paneKey,
          state: 'done' as const,
          prompt: 'Previous Claude turn',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'claude' as const,
          stateHistory: []
        }
        mockStoreState.tabsByWorktree = {
          'wt-1': [{ id: 'tab-1', ptyId: null, launchAgent: 'claude' }]
        }
        mockStoreState.agentStatusByPaneKey[paneKey] = claudeStatus
        mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
          agent: 'claude',
          shellForeground: false
        }

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks11)
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-false-cc')
        mockStoreState.setAgentStatus.mockClear()

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-false-cc',
          seq: 1,
          facts: [
            { kind: 'command-code-working', prompt: 'False prompt' },
            { kind: 'command-code-done', prompt: 'False prompt' }
          ]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBe(claudeStatus)
      })

      it('rejects Command Code facts when retained Claude identity owns the pane', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks12 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)
        const unknownStatus = {
          paneKey,
          state: 'working' as const,
          prompt: '',
          updatedAt: Date.now(),
          stateStartedAt: Date.now(),
          agentType: 'unknown' as const,
          stateHistory: []
        }
        mockStoreState.retainedAgentsByPaneKey[paneKey] = { agentType: 'claude' }
        mockStoreState.agentStatusByPaneKey[paneKey] = unknownStatus

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks12)
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-retained-false-cc')
        mockStoreState.setAgentStatus.mockClear()

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-retained-false-cc',
          seq: 1,
          facts: [
            { kind: 'command-code-working', prompt: 'False prompt' },
            { kind: 'command-code-done', prompt: 'False prompt' }
          ]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.setAgentStatus).not.toHaveBeenCalled()
        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toBe(unknownStatus)
      })

      it('keeps Command Code working when a working fact lands before the done settles', async () => {
        enableMainAuthority()
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks13 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)
        vi.useFakeTimers()
        const paneKey = makePaneKey('tab-1', LEAF_1)

        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(createDeps() as never, agentTitleMocks13)
        )
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-fact-cc-repaint')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 1,
          facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
        })
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 2,
          facts: [{ kind: 'command-code-done', prompt: 'Run a slow command' }]
        })
        vi.advanceTimersByTime(1000)
        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-fact-cc-repaint',
          seq: 3,
          facts: [{ kind: 'command-code-working', prompt: 'Run a slow command' }]
        })
        vi.advanceTimersByTime(2000)

        expect(mockStoreState.agentStatusByPaneKey[paneKey]).toMatchObject({
          state: 'working',
          prompt: 'Run a slow command',
          agentType: 'command-code'
        })
      })

      it('honors the persisted kill switch for panes bound before settings hydrate', async () => {
        // Pre-hydration: settings not loaded but kill switch persisted off — pane registers byte parsers, not a fact consumer.
        mockStoreState.settings = null
        ;(window.api as unknown as Record<string, unknown>).settings = {
          getSync: vi.fn(() => ({ terminalMainSideEffectAuthority: false }))
        }
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks15 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const handler =
          await import('../../pty-transport/output/terminal-side-effect-facts-handler')
        const transport = createMockTransport()
        transportFactoryQueue.push(transport)

        const deps = createDeps()
        connectPanePty(
          createPane(1) as never,
          createManager(1) as never,
          bindPaneAgentTitleMocks(deps as never, agentTitleMocks15)
        )

        for (const callback of SIDE_EFFECT_PARSER_CALLBACKS) {
          expect(createdTransportOptions[0]?.[callback]).toBeTypeOf('function')
        }
        const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as (ptyId: string) => void
        onPtySpawn('pty-prehydration')

        handler._dispatchTerminalSideEffectBatchForTest({
          ptyId: 'pty-prehydration',
          seq: 1,
          facts: [{ kind: 'bell' }]
        })
        expect(deps.markTerminalBell).not.toHaveBeenCalled()

        // Hydration with switch still off: byte parsing stays the single consumer — one BEL marks unread once.
        mockStoreState.settings = { terminalMainSideEffectAuthority: false }
        notifyStoreSubscribers()
        const onBell = createdTransportOptions[0]?.onBell as () => void
        onBell()
        expect(deps.markTerminalBell).toHaveBeenCalledTimes(1)
      })
    })
  })
}
