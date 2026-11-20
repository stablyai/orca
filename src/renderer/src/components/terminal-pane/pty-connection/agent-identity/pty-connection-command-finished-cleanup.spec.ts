import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST_REPLAY_REATTACH_RESET } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { TerminalKittyKeyboardModeTracker } from '../../../../../../shared/terminal/protocol/input-modes/terminal-kitty-keyboard-mode-tracker'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks, createDeferred } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  captureCallbackTerminalWrites,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from '../test-fixtures/pty-connection-test-store-state'
import {
  buildPaneConnectionDeps,
  type PtyConnectionAgentTitleMocks,
  bindPaneAgentTitleMocks
} from '../test-fixtures/pty-connection-test-deps'
import { createInitialStoreState } from '../test-fixtures/pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

export function registerPtyConnectionCommandFinishedCleanupTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
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

    it.each([
      ['keeps recovery until main proves the owning agent ended', false],
      // Hibernation records resume before kill; the exposed shell is Orca’s own stop rather than an independent agent exit.
      ['keeps sleeping identity when the shell surfaces during an intentional stop', true]
    ])('%s', async (_label, stoppingOnPurpose) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks5 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      window.api.agentStatus.hasVerifiableAgentProcess = vi.fn(async () => false)
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-sleeping-confirmed-shell'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(deps, agentTitleMocks5)
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'codex' }
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        worktreeId: 'wt-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-1' },
        capturedAt: 1,
        updatedAt: 1
      }
      if (stoppingOnPurpose) {
        mockStoreState.suppressedPtyExitIds[ptyId] = true
      }

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350)

      if (stoppingOnPurpose) {
        expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
          agent: 'codex'
        })
        expect(deps.onAgentExitedRef.current).not.toHaveBeenCalled()
      } else {
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'sess-1' }
        })
        expect(deps.onAgentExitedRef.current).toHaveBeenCalledWith(LEAF_1)
      }
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: true
      })
    })

    it('keeps recovery when wake-resumed Codex stops and the shell runs another command', async () => {
      vi.useFakeTimers()
      const agent = 'codex'
      const finishes = [
        [146, 'codex'],
        [0, 'zsh']
      ] as const
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')
      window.api.agentStatus.hasVerifiableAgentProcess = vi.fn(async () => false)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-suspended-agent')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: 'pty-suspended-agent' }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(createDeps({ isVisibleRef: { current: false } }), agentTitleMocks)
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: agent }
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        worktreeId: 'wt-1',
        agent,
        providerSession: { key: 'session_id', id: 'stopped-session' },
        capturedAt: 1,
        updatedAt: 1
      }
      for (const [status, foreground] of finishes) {
        vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(foreground)
        vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue(foreground)
        dataCallbackRef.current?.(`\x1b]133;C\x07\x1b]133;D;${status}\x07`)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
          agent,
          providerSession: { key: 'session_id', id: 'stopped-session' }
        })
      }
    })

    it('keeps sleeping identity when the foreground check still sees the agent', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      // Why both: the pane's process monitor reads the same foreground the confirm read sees.
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-sleeping-leaked-shell-marker'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef: { current: false } }),
            agentTitleMocks6
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'codex' }
      }
      mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] = {
        paneKey,
        worktreeId: 'wt-1',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'sess-1' },
        capturedAt: 1,
        updatedAt: 1
      }

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      await flushAsyncTicks()

      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        agent: 'codex'
      })
    })

    it('reconciles a pane that HAS a status row, whose own drop removes it first', async () => {
      // Use an accepted row to exercise deferred-drop bookkeeping before reconcile; the no-row path returns early.
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks7 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      // Import dynamically to share pty-connection’s live registry; a static import can be a stale instance.
      const { createCommandFinishedStatusStore } =
        await import('./command-finished-status-store-test-fixture')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
      vi.mocked(window.api.agentStatus.reconcileEndedProcess).mockClear()
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-claude-row-confirmed-shell'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef: { current: false } }),
            agentTitleMocks7
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      // A real working write carries accepted-status bookkeeping and the latch present during STA-4612 exits.
      const realStore = createCommandFinishedStatusStore()
      const row = realStore.acceptWorkingClaudeStatus(paneKey)
      expect(row).toBeDefined()
      mockStoreState.agentStatusByPaneKey = mockStoreState.agentStatusByPaneKey.replace([
        [paneKey, row]
      ])
      // Mirror both real dismissal and teardown to exercise drop-before-reconcile ordering.
      mockStoreState.dropAgentStatus.mockImplementation((key: string) => {
        mockStoreState.agentStatusByPaneKey = mockStoreState.agentStatusByPaneKey.replace([
          [key, null]
        ])
        realStore.dropAgentStatus(key)
      })

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350)

      expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
      expect(realStore.getStatus(paneKey)).toBeUndefined()
      expect(window.api.agentStatus.reconcileEndedProcess).toHaveBeenCalledWith(paneKey)
    })

    it('disarms stale TUI modes in the emulator after a confirmed return to shell', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks9 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('bash')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-stale-mode-disarm'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const { writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(
        ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks9))
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }

      // The agent negotiates Kitty keys across a chunk split, then dies armed.
      dataCallbackRef.current?.('\x1b[>')
      dataCallbackRef.current?.('5u')
      // SIGKILL omits mode teardown; bare 133;D cannot disarm until foreground inspection confirms exit.
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      expect(writes.some((w) => w.includes(POST_REPLAY_REATTACH_RESET))).toBe(false)
      expect(deps.paneKittyKeyboardModesRef.current.get(pane.id)?.flags).toBe(5)

      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()

      const disarm = writes.find((w) => w.includes(POST_REPLAY_REATTACH_RESET))
      expect(disarm).toBeDefined()
      // Preserve bracketed paste re-armed by the live shell before the delayed reset.
      expect(disarm).not.toContain('\x1b[?2004l')
      // Shortcut policy reads the mirror, so it must drop the dead app's flags with xterm.
      expect(deps.paneKittyKeyboardModesRef.current.get(pane.id)?.flags).toBe(0)
    })

    it('grounds xterm and the input mirror in stream order when output is still queued', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks10 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const confirmRead = createDeferred<string>()
      vi.mocked(window.api.pty.confirmForegroundProcess).mockReturnValue(confirmRead.promise)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-stale-mode-queued-output'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const { writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(
        ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks10))
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()
      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalled()

      // Hidden-pane output sits in the background queue when the shell proof lands.
      dataCallbackRef.current?.('\x1b[>5u')
      expect(writes.some((w) => w.includes('\x1b[>5u'))).toBe(false)
      confirmRead.resolve('bash')
      await flushAsyncTicks()
      await vi.advanceTimersByTimeAsync(100)

      // Parsing what xterm received, in order, must match the mirror.
      const xtermView = new TerminalKittyKeyboardModeTracker()
      writes.forEach((write) => xtermView.scan(write))
      expect(writes.some((w) => w.includes(POST_REPLAY_REATTACH_RESET))).toBe(true)
      expect(deps.paneKittyKeyboardModesRef.current.get(pane.id)?.flags).toBe(0)
      expect(xtermView.flags).toBe(0)
    })

    it('keeps armed modes while the agent still owns the foreground after a leaked 133;D', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks11 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      // Why both: the pane's process monitor reads the same foreground the confirm read sees.
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-stale-mode-live-agent'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const pane = createPane(1)
      const { writes } = captureCallbackTerminalWrites(pane)
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(
        ...mockPanePtyArgs(pane, createManager(1), bindPaneAgentTitleMocks(deps, agentTitleMocks11))
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }

      dataCallbackRef.current?.('\x1b[>5u')
      // Nested-shell 133;D leaves the agent foreground, so its mouse/Kitty modes must survive confirmation.
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      await flushAsyncTicks()

      expect(writes.some((w) => w.includes(POST_REPLAY_REATTACH_RESET))).toBe(false)
      expect(deps.paneKittyKeyboardModesRef.current.get(pane.id)?.flags).toBe(5)
    })

    it('retires stale routing after unavailable command-finish reads without reconciling', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks12 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue(null)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-droid-unavailable-finish'
      const tabId = 'tab-droid-unavailable-finish'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey(tabId, LEAF_1)

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({ tabId, isVisibleRef: { current: false } }),
            agentTitleMocks12
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }
      mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
        delete mockStoreState.agentLaunchConfigByPaneKey[key]
      })

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      await flushAsyncTicks()

      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      expect(window.api.agentStatus.reconcileEndedProcess).not.toHaveBeenCalled()
    })

    it('cancels deferred cleanup on a new command and retires identity at its later shell', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks13 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('powershell.exe')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const ptyId = 'pty-droid-superseded-confirmation'
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({ isVisibleRef: { current: false } }),
            agentTitleMocks13
          )
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'droid' }
      }
      mockStoreState.clearAgentLaunchConfig.mockImplementation((key: string) => {
        delete mockStoreState.agentLaunchConfigByPaneKey[key]
      })

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      dataCallbackRef.current?.('\x1b]133;C\x07')
      expect(mockStoreState.clearAgentLaunchConfig).not.toHaveBeenCalled()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledExactlyOnceWith(paneKey)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    })
  })
}
