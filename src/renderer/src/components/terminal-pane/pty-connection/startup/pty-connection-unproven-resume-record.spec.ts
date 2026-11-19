import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import { mainLayoutApplyTransport } from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import {
  LEAF_1,
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

export function registerPtyConnectionUnprovenResumeRecordTests(): void {
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
      ;(await mainLayoutApplyTransport()).reset()
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    // A restored Codex can fail in startup (e.g. its account lookup times out) and drop back to the shell.
    async function resumeCodexThenReturnToShell(
      report: 'never' | 'after-connect' | 'during-connect'
    ): Promise<string> {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      vi.mocked(window.api.pty.confirmForegroundProcess).mockResolvedValue('bash')
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const reportIn = (): void => {
        mockStoreState.agentStatusByPaneKey = acceptedAgentStatuses([
          [
            paneKey,
            {
              paneKey,
              agentType: 'codex',
              state: 'done',
              prompt: '',
              stateStartedAt: Date.now(),
              updatedAt: Date.now(),
              stateHistory: []
            }
          ]
        ])
      }
      const dataCallbackRef: { current: ((data: string) => void) | null } = { current: null }
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(
        async ({ callbacks }: { callbacks: { onData?: (data: string) => void } }) => {
          dataCallbackRef.current = callbacks.onData ?? null
          if (report === 'during-connect') {
            // The agent's first hook can land before the spawn settles.
            reportIn()
            await new Promise((resolve) => setTimeout(resolve, 5))
          }
          return { id: 'fresh-pty', coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' } }
        }
      )
      transportFactoryQueue.push(transport)
      mockStoreState.tabsByWorktree = { 'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }] }
      mockStoreState.settings = { ...mockStoreState.settings, agentCmdOverrides: {} }
      mockStoreState.agentStatusByPaneKey = acceptedAgentStatuses([])
      mockStoreState.sleepingAgentSessionsByPaneKey = {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: '',
          state: 'done',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'live'
        }
      }

      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              restoredLeafId: LEAF_1,
              restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
            }),
            agentTitleMocks
          )
        )
      )
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "codex 'resume' 'codex-session-1'"
        })
      )
      mockStoreState.agentLaunchConfigByPaneKey[paneKey] = {
        launchConfig: { agentArgs: '', agentEnv: {} },
        identity: { agentType: 'codex' }
      }
      if (report === 'after-connect') {
        await vi.advanceTimersByTimeAsync(10)
        reportIn()
      }
      dataCallbackRef.current?.('\x1b]133;D;0\x07')
      await vi.advanceTimersByTimeAsync(350)
      expect(mockStoreState.paneForegroundAgentByPaneKey[paneKey]?.shellForeground).toBe(true)
      return paneKey
    }

    it('keeps the resume record when the resumed agent exits before reporting in', async () => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return
      }
      const paneKey = await resumeCodexThenReturnToShell('never')

      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        providerSession: { id: 'codex-session-1' }
      })
    })

    it('retires the resume record once the resumed agent reported in and then exited', async () => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return
      }
      const paneKey = await resumeCodexThenReturnToShell('after-connect')

      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    })

    it('counts a report that lands before the resume spawn settles as proof', async () => {
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        return
      }
      const paneKey = await resumeCodexThenReturnToShell('during-connect')

      expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    })
  })
}
