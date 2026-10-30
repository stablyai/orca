import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_1,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import { resolveMockPaneWindowsShiftEnterEncoding } from './pty-connection-test-store-state'
import { hasCtrlEnterCsiUAuthorityForPane } from './terminal-ctrl-enter'
import { mockPanePtyArgs } from './pty-connection-test-connect-mock-pane'

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

    async function connectRestoredPane(
      ptyId: string,
      visible: boolean
    ): Promise<{
      cacheKey: string
      pane: ReturnType<typeof createPane>
      binding: { sampleForegroundAgentOnFocus: () => void }
      deps: ReturnType<typeof createDeps>
    }> {
      const { connectPanePty } = await import('./pty-connection')
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
      const pane = createPane(1)
      const binding = connectPanePty(...mockPanePtyArgs(pane, createManager(1), deps))
      await vi.advanceTimersByTimeAsync(20)
      await flushAsyncTicks(20)
      return { cacheKey: makePaneKey(tabId, LEAF_1), binding, deps, pane }
    }

    it('retires a hand-typed Codex read in a pane without command marks once it exits', async () => {
      vi.useFakeTimers()
      const ptyId = 'pty-unmarked-codex-exit'
      let foreground: string | null = 'codex'
      let children = true
      vi.mocked(window.api.pty.getForegroundProcess).mockImplementation(async () => foreground)
      vi.mocked(window.api.pty.hasChildProcesses).mockImplementation(async () => children)

      const { cacheKey, pane, deps } = await connectRestoredPane(ptyId, true)
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
        shellForeground: true
      })
      expect(mockStoreState.clearAgentLaunchConfig).toHaveBeenCalledWith(cacheKey)
      expect(deps.onAgentExitedRef.current).toHaveBeenCalledWith(LEAF_1)

      // Stale agent titles cannot retain agent-specific keys in the shell.
      expect(hasCtrlEnterCsiUAuthorityForPane(mockStoreState, cacheKey, 'Droid')).toBe(false)
      expect(resolveMockPaneWindowsShiftEnterEncoding(mockStoreState, cacheKey, 'Droid')).toBe(
        'alt-enter'
      )
      // The next unmarked launch is discovered even while the pane remains hidden.
      deps.isVisibleRef.current = false
      foreground = 'droid'
      children = true
      sendTerminalInputThroughPane(pane, '\r')
      await vi.advanceTimersByTimeAsync(3_000)
      expect(mockStoreState.paneForegroundAgentByPaneKey[cacheKey]).toMatchObject({
        agent: 'droid',
        agentEvidence: 'process-read'
      })
    })
  })
}
