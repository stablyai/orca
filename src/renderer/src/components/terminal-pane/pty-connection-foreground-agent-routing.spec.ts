import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  VISIBLE_PTY_SETTLE_MS,
  WRAPPER_RESOLVE_RETRY_MS,
  SECOND_WRAPPER_RETRY_MS
} from './pty-connection-test-constants'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import {
  resolveMockPaneWindowsShiftEnterEncoding,
  type StoreState
} from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

export function registerPtyConnectionForegroundAgentRoutingTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty', () => {
    beforeEach(async () => {
      vi.resetModules()
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

    it('drops agent status without retaining when OSC 133 reports the command finished', async () => {
      const { connectPanePty } = await import('./pty-connection')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport()
      let currentPtyId: string | null = null
      vi.mocked(transport.getPtyId).mockImplementation(() => currentPtyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          currentPtyId = 'pty-local-1'
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-1'
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        agentStatusByPaneKey: {
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
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({ isVisibleRef: { current: false } })

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))

      capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
      await flushAsyncTicks()

      expect(mockStoreState.dropAgentStatus).toHaveBeenCalledWith(paneKey)
      expect(mockStoreState.removeAgentStatus).not.toHaveBeenCalled()
    })

    it('clears pre-hook launch config when an Orca-started command exits', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const { connectPanePty } = await import('./pty-connection')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('zsh')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport()
      let currentPtyId: string | null = null
      vi.mocked(transport.getPtyId).mockImplementation(() => currentPtyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          currentPtyId = 'pty-local-1'
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-local-1'
        }
      )
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        ptyIdsByTabId: { 'tab-1': [] }
      } as StoreState

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          createDeps({
            startup: {
              command: "codex '--dangerously-bypass-approvals-and-sandbox'",
              launchConfig: {
                agentArgs: '--dangerously-bypass-approvals-and-sandbox',
                agentEnv: {}
              },
              launchAgent: 'codex'
            },
            restoredPtyIdByLeafId: {}
          })
        )
      )

      expect(mockStoreState.registerAgentLaunchConfig).toHaveBeenCalledWith(
        paneKey,
        {
          agentArgs: '--dangerously-bypass-approvals-and-sandbox',
          agentEnv: {}
        },
        expect.objectContaining({ agentType: 'codex' })
      )
      capturedDataCallback.current?.('\x1b]133;D;130\x07thebr ~/repo $ ')
      await flushAsyncTicks()
      await vi.advanceTimersByTimeAsync(350)
      await flushAsyncTicks()

      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(paneKey)
      expect(mockStoreState.dropAgentStatus).not.toHaveBeenCalled()
    })

    it('routes a manually typed Droid only after foreground enrichment confirms it', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const ptyId = 'pty-manually-typed-droid'
      const tabId = 'tab-manually-typed-droid'
      const foregroundResults = ['powershell.exe', 'droid']
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async (id: string) =>
        id === ptyId ? (foregroundResults.shift() ?? 'droid') : null
      )
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
          pane,
          createManager(1),
          createDeps({ tabId, isVisibleRef: { current: false } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      dataCallbackRef.current?.('\x1b]133;C\x07')
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      await vi.advanceTimersByTimeAsync(350)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      await vi.advanceTimersByTimeAsync(1200)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
    })

    it('confirms a manually typed Droid without OSC command boundaries', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
      const pane = createPane(1)
      const ptyId = 'pty-manual-droid-no-osc'
      const tabId = 'tab-manual-droid-no-osc'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId, isVisibleRef: { current: false } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      await vi.advanceTimersByTimeAsync(350)

      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
    })

    it('confirms an Orca-launched Droid fresh spawn in a no-OSC shell (Git Bash)', async () => {
      // Why: no-OSC shells (Git Bash/cmd) emit no command boundary, so without a fresh-spawn sample the pane never earns routing trust and Shift+Enter regresses to Esc+CR (#7620).
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('droid')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('droid')
      const pane = createPane(1)
      const ptyId = 'pty-launched-droid-no-osc'
      const tabId = 'tab-launched-droid-no-osc'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({
            tabId,
            startup: { command: 'droid', launchAgent: 'droid' }
          })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      // The transport reports the fresh spawn; no OSC 133, no typed inference.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Captured transport options expose onPtySpawn as an optional PTY-id callback.
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      expect(onPtySpawn).toBeTypeOf('function')
      onPtySpawn?.(ptyId)
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      expect(window.api.pty.confirmForegroundProcess).toHaveBeenCalledWith(ptyId)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
    })

    it('trusts a launched Droid whose no-OSC boot only becomes foreground after retries', async () => {
      // Why: the confirmation ladder must span Droid's boot — the shell is still foreground on the first read(s) before Droid takes over.
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const foregroundResults = ['bash.exe', 'bash.exe', 'droid']
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(
        async () => foregroundResults.shift() ?? 'droid'
      )
      const pane = createPane(1)
      const ptyId = 'pty-launched-droid-slow-boot'
      const tabId = 'tab-launched-droid-slow-boot'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId, startup: { command: 'droid', launchAgent: 'droid' } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Captured transport options expose onPtySpawn as an optional PTY-id callback.
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      onPtySpawn?.(ptyId)
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
    })

    it('stays recoverable when a launched Droid outlasts the fresh-spawn confirmation window', async () => {
      // Why: a missed ladder (slow boot) must stay recoverable — latching a shell-confirm would clear launch identity and poison Shift+Enter for the session.
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      let foreground = 'bash.exe'
      // Why both: the pane's process monitor reads the same foreground the confirm read sees.
      vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => foreground)
      const pane = createPane(1)
      const ptyId = 'pty-launched-droid-slow'
      const tabId = 'tab-launched-droid-slow'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId, startup: { command: 'droid', launchAgent: 'droid' } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Captured transport options expose onPtySpawn as an optional PTY-id callback.
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      onPtySpawn?.(ptyId)
      // Whole ladder elapses while the shell is still foreground (Droid not up yet).
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      await flushAsyncTicks()

      // Benign miss: shell never latched as foreground; encoding still safe fallback.
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      // Droid finally boots and a focus event re-samples: trust is recoverable.
      foreground = 'droid'
      binding.sampleForegroundAgentOnFocus()
      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)
      await flushAsyncTicks()

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        agentEvidence: 'process-read',
        routingTrusted: true,
        shellForeground: false
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
    })

    it('confirms a delayed Claude from fresh startup output after the first read window expires', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      let foreground = 'sleep'
      vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => foreground)
      const tabId = 'tab-delayed-claude'
      const ptyId = 'pty-delayed-claude'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          createDeps({ tabId, startup: { command: 'sleep 30 && claude' } })
        )
      )
      await vi.advanceTimersByTimeAsync(30_000)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.agent).not.toBe('claude')

      foreground = 'claude'
      const onTitleChange = createdTransportOptions[0]?.onTitleChange
      if (typeof onTitleChange !== 'function') {
        throw new Error('Missing live title consumer')
      }
      // Captured with capture-agent-pty-transcript.mjs from a real delayed Claude launch.
      onTitleChange('✳ Claude Code', '✳ Claude Code')
      await vi.advanceTimersByTimeAsync(350)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toMatchObject({
        agent: 'claude',
        agentEvidence: 'process-read',
        routingTrusted: true
      })
      binding.dispose()
    })

    it('revokes trusted Droid after accepted no-OSC exit input until shell confirmation', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('cmd.exe')
      const pane = createPane(1)
      const ptyId = 'pty-droid-exit-no-osc'
      const tabId = 'tab-droid-exit-no-osc'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      connectPanePty(...mockPanePtyArgs(pane, createManager(1), createDeps({ tabId })))
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      mockStoreState.paneForegroundAgentByPaneKey[paneKey] = {
        agent: 'droid',
        routingTrusted: true,
        shellForeground: false
      }

      sendTerminalInputThroughPane(pane, '\x03')
      await flushAsyncTicks()

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: 'droid',
        routingRevoked: true,
        routingConfirmationPending: true,
        shellForeground: false
      })
      // The provider read is asynchronous; keep the last known safe capability
      // so a second Shift+Enter cannot become Pi's submit chord in the gap.
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')

      await vi.advanceTimersByTimeAsync(350 + 1200 + 6000)

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: true
      })
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    })

    it('trusts Pi in a no-OSC shell and retires routing after accepted exit input', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      let foreground = 'pi'
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('pi')
      vi.mocked(window.api.pty.confirmForegroundProcess).mockImplementation(async () => foreground)
      const pane = createPane(1)
      const ptyId = 'pty-pi-no-osc-lifecycle'
      const tabId = 'tab-pi-no-osc-lifecycle'
      const paneKey = makePaneKey(tabId, LEAF_1)
      transportFactoryQueue.push(createMockTransport(ptyId))

      const binding = connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId, startup: { command: 'pi', launchAgent: 'pi' } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Captured transport options expose onPtySpawn as an optional PTY-id callback.
      const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
        | ((id: string) => void)
        | undefined
      onPtySpawn?.(ptyId)
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')

      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(200)
      binding.requestWindowsShiftEnterReconfirmation()
      await vi.advanceTimersByTimeAsync(700)
      await flushAsyncTicks()
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')

      foreground = 'cmd.exe'
      sendTerminalInputThroughPane(pane, '\x03')
      await flushAsyncTicks()
      // A provider read is pending; do not turn the next Pi Shift+Enter into submit.
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('csi-u')
      await vi.advanceTimersByTimeAsync(
        VISIBLE_PTY_SETTLE_MS + WRAPPER_RESOLVE_RETRY_MS + SECOND_WRAPPER_RETRY_MS
      )
      await flushAsyncTicks()

      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]).toEqual({
        agent: null,
        shellForeground: true
      })
    })

    it('never promotes typed Droid text when foreground enrichment is unavailable', async () => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      vi.mocked(window.api.pty.confirmForegroundProcess)
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('inspection unavailable'))
        .mockResolvedValueOnce(null)
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const pane = createPane(1)
      const ptyId = 'pty-typed-droid-unavailable-start'
      const tabId = 'tab-typed-droid-unavailable-start'
      const paneKey = makePaneKey(tabId, LEAF_1)
      const transport = createMockTransport(ptyId)
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          return { id: ptyId }
        }
      )
      transportFactoryQueue.push(transport)

      connectPanePty(
        ...mockPanePtyArgs(
          pane,
          createManager(1),
          createDeps({ tabId, isVisibleRef: { current: false } })
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks()

      sendTerminalInputThroughPane(pane, 'droid\r')
      dataCallbackRef.current?.('\x1b]133;C\x07')
      await vi.advanceTimersByTimeAsync(350)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      await vi.advanceTimersByTimeAsync(1200)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')

      await vi.advanceTimersByTimeAsync(5999)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
      await vi.advanceTimersByTimeAsync(1)

      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, paneKey)).toBe('alt-enter')
    })
  })
}
