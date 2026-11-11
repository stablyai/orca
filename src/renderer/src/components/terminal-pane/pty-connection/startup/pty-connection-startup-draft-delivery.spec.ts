import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { beginAgentStartupDeliveryAttempt } from '@/lib/agent-session/launch/startup/agent-startup-delayed-delivery'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
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
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

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

    it('keeps startup draft ownership while deferred connect waits through setup', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks2 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const { beginAgentStartupDeliveryAttempt: claimStartupDelivery } =
        await import('@/lib/agent-session/launch/startup/agent-startup-delayed-delivery')

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

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks2))
      )

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
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
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
          bindPaneAgentTitleMocks(
            createDeps({
              startup: {
                command: 'codex',
                launchAgent: 'codex',
                launchConfig: { agentArgs: '', agentEnv: {} },
                launchToken: 'launch-token-1',
                draftPrompt: 'https://github.com/stablyai/orca/issues/42'
              }
            }),
            agentTitleMocks3
          )
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
