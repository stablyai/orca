import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from '../test-fixtures/pty-connection-test-pane-fixtures'
import type { StoreState } from '../test-fixtures/pty-connection-test-store-state'
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

export function registerPtyConnectionForegroundProcessExitTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []

  function createDeps(overrides: Record<string, unknown> = {}) {
    return buildPaneConnectionDeps(() => mockStoreState, overrides)
  }

  describe('connectPanePty process-exit retirement', () => {
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

    async function connectRestoredPane(
      ptyId: string,
      visible: boolean
    ): Promise<{
      cacheKey: string
      binding: { sampleForegroundAgentOnFocus: () => void }
      deps: ReturnType<typeof createDeps>
    }> {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const tabId = `tab-${ptyId}`
      const transport = createMockTransport(ptyId)
      transport.getPtyId.mockImplementation(() => ptyId)
      transport.connect.mockImplementation(async () => null)
      transportFactoryQueue.push(transport)
      const deps = createDeps({
        tabId,
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: ptyId },
        isVisibleRef: { current: visible }
      })
      const binding = connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(deps, agentTitleMocks)
        )
      )
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      return { cacheKey: makePaneKey(tabId, LEAF_1), binding, deps }
    }

    it('retires a hand-typed Codex read in a pane without command marks once it exits', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-unmarked-codex-exit'
      let foreground: string | null = 'codex'
      let children = true
      vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
      vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => children)

      const { cacheKey, binding, deps } = await connectRestoredPane(ptyId, true)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toMatchObject({
        agent: 'codex',
        agentEvidence: 'process-read'
      })

      foreground = 'zsh'
      children = false
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toEqual({
        agent: null,
        shellForeground: false
      })
      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(cacheKey)
      expect(deps.onAgentExitedRef.current).toHaveBeenCalledWith(LEAF_1)

      // Codex typed again in the same unmarked pane: the next sample must identify it.
      foreground = 'codex'
      children = true
      binding.sampleForegroundAgentOnFocus()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toMatchObject({
        agent: 'codex',
        agentEvidence: 'process-read'
      })
    })
  })
}
