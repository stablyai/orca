import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sendTerminalInputThroughPane } from '../test-fixtures/pty-connection-test-dom'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
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

export function registerPtyConnectionTerminalInputSessionListingTests(): void {
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

    describe('terminal input liveness IPC gating (perf)', () => {
      // Why (perf regression guard): listSessions() is a renderer→main→daemon round-trip; terminal input must never trigger it.
      async function connectActivePaneWithInput(): Promise<{
        binding: { noteVisibilityResume: () => void }
        transport: MockTransport
        typeKeystroke: (data?: string) => void
      }> {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks16 =
          await vi.importMock<PtyConnectionAgentTitleMocks>('@/lib/agent-status')
        const transport = createMockTransport('pty-pane-2')
        transportFactoryQueue.push(transport)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          paneTransportsRef: { current: new Map([[1, createMockTransport('pty-pane-1')]]) }
        })
        const pane = createPane(2)
        const binding = connectPanePty(
          ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks16))
        )
        return {
          binding,
          transport,
          // Drives the real xterm onData (terminal input) handler.
          typeKeystroke: (data = 'a') => sendTerminalInputThroughPane(pane, data)
        }
      }

      it('does not fire listSessions for first input on a fresh mount', async () => {
        const listSessions = vi.mocked(window.api.pty.listSessions)
        listSessions.mockClear()
        const { typeKeystroke } = await connectActivePaneWithInput()

        for (let i = 0; i < 25; i++) {
          typeKeystroke('x')
        }

        expect(listSessions).not.toHaveBeenCalled()
      })

      it('does not fire listSessions for input after a visibility resume', async () => {
        const listSessions = vi.mocked(window.api.pty.listSessions)
        listSessions.mockClear()
        const { binding, typeKeystroke } = await connectActivePaneWithInput()

        binding.noteVisibilityResume()
        typeKeystroke('a')
        typeKeystroke('b')

        expect(listSessions).not.toHaveBeenCalled()
      })

      it('sends the first post-resume input without starting the liveness re-check', async () => {
        const listSessions = vi.mocked(window.api.pty.listSessions)
        listSessions.mockClear()
        const calls: string[] = []
        listSessions.mockImplementation(() => {
          calls.push('listSessions')
          return Promise.resolve([])
        })
        const { binding, transport, typeKeystroke } = await connectActivePaneWithInput()
        transport.sendInput.mockImplementation(() => {
          calls.push('sendInput')
          return true
        })

        binding.noteVisibilityResume()
        typeKeystroke('a')

        expect(calls).toEqual(['sendInput'])
      })

      it('does not re-arm input-driven listSessions across repeated visibility resumes', async () => {
        const listSessions = vi.mocked(window.api.pty.listSessions)
        listSessions.mockClear()
        const { binding, typeKeystroke } = await connectActivePaneWithInput()

        binding.noteVisibilityResume()
        typeKeystroke('a')
        typeKeystroke('b')
        expect(listSessions).not.toHaveBeenCalled()

        binding.noteVisibilityResume()
        typeKeystroke('c')
        typeKeystroke('d')
        expect(listSessions).not.toHaveBeenCalled()
      })
    })
  })
}
