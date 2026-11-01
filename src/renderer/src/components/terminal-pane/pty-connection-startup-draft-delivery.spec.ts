import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { beginAgentStartupDeliveryAttempt } from '@/lib/agent-startup-delayed-delivery'
import { flushAsyncTicks } from './pty-connection-test-async'
import { VISIBLE_PTY_SETTLE_MS } from './pty-connection-test-constants'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type ConnectCallbacks,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

export function registerPtyConnectionStartupDraftDeliveryTests(): void {
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

    it.each([10_000, 20_000])('keeps Codex draft delivery bounded after %d ms', async (waitMs) => {
      vi.useFakeTimers()
      const { connectPanePty } = await import('./pty-connection')
      const { beginAgentStartupDeliveryAttempt: claimStartupDelivery } =
        await import('@/lib/agent-startup-delayed-delivery')

      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-codex')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-codex'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'codex',
          launchAgent: 'codex',
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'launch-token-1',
          draftPrompt: 'https://github.com/stablyai/orca/issues/42'
        }
      })
      vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

      const binding = connectPanePty(...mockPanePtyArgs(pane, manager, deps))
      await vi.advanceTimersByTimeAsync(VISIBLE_PTY_SETTLE_MS)
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()

      // A focused xterm emits CSI I after Codex enables focus reporting; the startup draft must reuse the same transport instead of racing a direct IPC.
      ;(
        pane.terminal.onData as unknown as {
          mock: { calls: [(data: string) => void][] }
        }
      ).mock.calls[0]?.[0]('\x1b[I')
      ;(
        pane.terminal.onData as unknown as {
          mock: { calls: [(data: string) => void][] }
        }
      ).mock.calls[0]?.[0]('USER_DRAFT')
      ;(mockStoreState.recordTerminalInput as ReturnType<typeof vi.fn>).mockClear()
      await vi.advanceTimersByTimeAsync(waitMs)
      expect(transport.sendInputAccepted).not.toHaveBeenCalled()
      capturedDataCallback.current?.('\x1b[?2004h\x1b[2K› ')
      await flushAsyncTicks()

      if (waitMs === 20_000) {
        expect(transport.sendInputAccepted).not.toHaveBeenCalled()
        expect(transport.sendInput.mock.calls.map(([data]) => data)).toEqual([
          '\x1b[I',
          'USER_DRAFT'
        ])
        binding.dispose()
        expect(
          claimStartupDelivery({
            worktreeId: 'wt-1',
            tabId: 'tab-1',
            launchToken: 'launch-token-1'
          })
        ).toBe(false)
        return
      }

      expect(transport.sendInputAccepted).toHaveBeenCalledWith(
        '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~',
        'launch'
      )
      expect(transport.sendInput.mock.calls.map(([data]) => data)).toEqual([
        '\x1b[I',
        'USER_DRAFT',
        '\x1b[200~https://github.com/stablyai/orca/issues/42\x1b[201~'
      ])
      expect(window.api.pty.writeAccepted).not.toHaveBeenCalled()
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledOnce()
      expect(mockStoreState.recordTerminalInput).toHaveBeenCalledWith(makePaneKey('tab-1', LEAF_1))
    })

    it('keeps startup draft ownership while deferred connect waits through setup', async () => {
      const { connectPanePty } = await import('./pty-connection')
      const { beginAgentStartupDeliveryAttempt: claimStartupDelivery } =
        await import('@/lib/agent-startup-delayed-delivery')

      const deferredFrames: FrameRequestCallback[] = []
      globalThis.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
        deferredFrames.push(callback)
        return 1
      })
      const capturedDataCallback: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('pty-codex')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: ConnectCallbacks }) => {
          capturedDataCallback.current = callbacks.onData ?? null
          return 'pty-codex'
        }
      )
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        startup: {
          command: 'wait-for-setup-then-codex',
          launchAgent: 'codex',
          launchConfig: { agentArgs: '', agentEnv: {} },
          launchToken: 'launch-token-setup',
          draftPrompt: 'Linked Linear issue: STA-905'
        }
      })

      connectPanePty(...mockPanePtyArgs(pane, manager, deps))

      const sidecarClaimed = claimStartupDelivery({
        worktreeId: 'wt-1',
        tabId: 'tab-1',
        launchToken: 'launch-token-setup'
      })
      expect(sidecarClaimed).toBe(false)

      let frameCount = 0
      while (deferredFrames.length > 0 && transport.connect.mock.calls.length === 0) {
        if (frameCount >= 20) {
          throw new Error('startup did not connect after the deferred setup handoff')
        }
        frameCount += 1
        deferredFrames.shift()?.(frameCount * 16)
      }
      await flushAsyncTicks()
      expect(capturedDataCallback.current).not.toBeNull()
      capturedDataCallback.current?.('\x1b[?2004hWaiting for setup to finish...')
      expect(transport.sendInputAccepted).not.toHaveBeenCalled()

      capturedDataCallback.current?.('\x1b[?2004h\x1b[2K› ')
      await flushAsyncTicks()

      expect(transport.sendInputAccepted).toHaveBeenCalledTimes(1)
      expect(transport.sendInputAccepted).toHaveBeenCalledWith(
        '\x1b[200~Linked Linear issue: STA-905\x1b[201~',
        'launch'
      )
    })

    it('releases startup draft delivery when disposed before deferred connect starts', async () => {
      const { connectPanePty } = await import('./pty-connection')
      globalThis.requestAnimationFrame = vi.fn(() => 1)
      const transport = createMockTransport('pty-codex')
      transportFactoryQueue.push(transport)

      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: null }] },
        repos: [{ id: 'repo1', connectionId: null }]
      }

      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          createDeps({
            startup: {
              command: 'codex',
              launchAgent: 'codex',
              launchConfig: { agentArgs: '', agentEnv: {} },
              launchToken: 'launch-token-1',
              draftPrompt: 'https://github.com/stablyai/orca/issues/42'
            }
          })
        )
      )

      binding.dispose()

      expect(transport.connect).not.toHaveBeenCalled()
      expect(
        beginAgentStartupDeliveryAttempt({
          worktreeId: 'wt-1',
          tabId: 'tab-1',
          launchToken: 'launch-token-1'
        })
      ).toBe(true)
    })
  })
}
