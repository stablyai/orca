import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  expectNoWindowStart,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { UUID_RE } from '../test-fixtures/pty-connection-test-constants'
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

export function registerPtyConnectionColdRestoreResumeCommandTests(): void {
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

    it('re-runs the resume command when a hibernated local session reattaches with no payload', async () => {
      // Why: the daemon drops startup commands on reattach, so a passive hibernation record must replace a contentless adopted shell.
      const pendingTimeouts: (() => void)[] = []
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = vi.fn((fn: () => void) => {
        pendingTimeouts.push(fn)
        return 999 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout

      try {
        const { connectPanePty } = await import('../connect-pane-pty')
        const agentTitleMocks = await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
        const paneKey = makePaneKey('tab-1', LEAF_2)
        let activePtyId: string | null = 'restored-session'
        const transport = createMockTransport('restored-session')
        transport.getPtyId.mockImplementation(() => activePtyId)
        transport.disconnect.mockImplementation(() => {
          activePtyId = null
        })
        transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
          if (opts.sessionId) {
            activePtyId = opts.sessionId
            return {
              id: opts.sessionId,
              isReattach: true,
              snapshot: undefined,
              replay: undefined,
              coldRestore: undefined
            }
          }
          activePtyId = 'fresh-resume-pty'
          const onPtySpawn = createdTransportOptions[0]?.onPtySpawn as
            | ((ptyId: string) => void)
            | undefined
          onPtySpawn?.('fresh-resume-pty')
          return 'fresh-resume-pty'
        })
        transportFactoryQueue.push(transport)
        mockStoreState = {
          ...mockStoreState,
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
          settings: {
            ...mockStoreState.settings,
            agentCmdOverrides: {}
          },
          sleepingAgentSessionsByPaneKey: {
            [paneKey]: {
              paneKey,
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              agent: 'codex',
              providerSession: { key: 'session_id', id: 'codex-session-1' },
              prompt: 'finish the task',
              state: 'done',
              origin: 'worktree-sleep',
              capturedAt: 1,
              updatedAt: 1
            }
          }
        } satisfies StoreState
        const pane = createPane(2)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
        })
        vi.mocked(window.api.pty.declarePendingPaneSerializer)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2)

        connectPanePty(
          ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks))
        )
        await flushAsyncTicks(20)
        for (const fn of pendingTimeouts) {
          fn()
        }
        await flushAsyncTicks(10)

        if (ORCA_LAYOUT_OWNER_IS_MAIN) {
          // Only main replaces the contentless shell and resumes the agent; the window drops its old view and asks main.
          expect(transport.disconnect).toHaveBeenCalled()
          await expectWindowStartAskedMain(transport, paneKey)
          expectNoWindowStart(transport, mockStoreState)
          expect(transport.sendInput).not.toHaveBeenCalled()
          expect(deps.clearExitedPanePtyLayoutBinding).not.toHaveBeenCalled()
          return
        }
        expect(transport.disconnect).toHaveBeenCalledTimes(1)
        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.connect).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            command: "codex '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'",
            env: expect.objectContaining({
              ORCA_PANE_KEY: paneKey,
              ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
            })
          })
        )
        expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
        expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
        expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, 'restored-session')
        expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-resume-pty')
        expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
          paneKey,
          origin: 'quit',
          restoreOnTabOpenOnly: true
        })
        expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(paneKey, 1)
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })

    it('keeps a contentless reattach when a live status supersedes passive sleep evidence', async () => {
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks4 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const paneKey = makePaneKey('tab-1', LEAF_2)
      const transport = createMockTransport('restored-session')
      transport.connect.mockResolvedValue({
        id: 'restored-session',
        isReattach: true,
        snapshot: undefined,
        replay: undefined,
        coldRestore: undefined
      })
      transportFactoryQueue.push(transport)
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: 'restored-session' }] },
        settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
        agentStatusByPaneKey: acceptedAgentStatuses(
          Object.entries({
            [paneKey]: {
              state: 'working',
              prompt: 'new live task',
              agentType: 'codex',
              providerSession: { key: 'session_id', id: 'live-codex-session' },
              paneKey,
              updatedAt: 2,
              stateStartedAt: 2,
              stateHistory: []
            }
          })
        ),
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'old-codex-session' },
            prompt: 'old completed task',
            state: 'done',
            origin: 'worktree-sleep',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } satisfies StoreState
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks4))
      )
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.disconnect).not.toHaveBeenCalled()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    })
  })
}
