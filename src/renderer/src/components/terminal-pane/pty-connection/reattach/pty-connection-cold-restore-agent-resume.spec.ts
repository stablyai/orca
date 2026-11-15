import { acceptedAgentStatuses } from '@/store/slices/agent-status/accepted-agent-statuses'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'
import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  expectWindowPaintsColdRestoreOnly,
  mainLayoutApplyTransport
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { RESET_GRAPHIC_RENDITION } from '../../../../../../shared/terminal/protocol/input-modes/terminal-mode-reset-profiles'
import { flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
import { UUID_RE } from '../test-fixtures/pty-connection-test-constants'
import {
  terminalWriteText,
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

export function registerPtyConnectionColdRestoreAgentResumeTests(): void {
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

    it('resumes the same agent after consecutive daemon losses before another status arrives', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks3 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      const paneKey = makePaneKey('tab-1', LEAF_1)
      const transcriptPath =
        '\\\\?\\C:\\Users\\Example\\.codex\\sessions\\2026\\07\\20\\rollout-codex-session-1.jsonl'
      // Why: after restart agentStatusByPaneKey is empty — the persisted sleeping record is the only provider session id source (#5232).
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
        agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: {
              key: 'session_id',
              id: 'codex-session-1',
              transcriptPath
            },
            prompt: 'finish the task',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } satisfies StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      const binding = connectPanePty(
        ...mockPanePtyArgs(pane, manager, bindPaneAgentTitleMocks(deps, agentTitleMocks3))
      )
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // Main resumes the agent; the window attaches, paints the host's history, and resumes nothing.
        expectWindowPaintsColdRestoreOnly(pane, transport, deps, mockStoreState, 'lost-pty')
        return
      }

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_GRAPHIC_RENDITION}cold-payload`,
        expect.any(Function)
      )
      expect(pane.terminal.write).not.toHaveBeenCalledWith(
        expect.stringContaining('--- session restored ---'),
        expect.any(Function)
      )
      const writeCalls = pane.terminal.write.mock.calls.map(([data]) => terminalWriteText(data))
      expect(writeCalls.findIndex((data) => data.includes('--- session restored ---'))).toBe(-1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledTimes(1)
      expect(deps.onShowSessionRestoredBanner).toHaveBeenCalledWith(1, 'restored')
      expect(transport.sendInput).not.toHaveBeenCalled()
      expect(transport.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'lost-pty',
          command: "codex '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'",
          resumeProviderSession: {
            key: 'session_id',
            id: 'codex-session-1',
            transcriptPath
          },
          env: expect.objectContaining({
            ORCA_PANE_KEY: paneKey,
            ORCA_TAB_ID: 'tab-1',
            ORCA_WORKTREE_ID: 'wt-1',
            ORCA_WORKSPACE_ID: 'wt-1',
            ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
          })
        })
      )
      expect(Array.from(mockStoreState.agentStatusByPaneKey.values())).toEqual([])
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        paneKey,
        providerSession: { id: 'codex-session-1', transcriptPath },
        origin: 'quit',
        restoreOnTabOpenOnly: true
      })
      binding.dispose()
      const replacement = createMockTransport('second-fresh-pty')
      replacement.connect.mockResolvedValue({
        id: 'second-fresh-pty',
        coldRestore: { scrollback: 'second-payload', cwd: '/tmp/wt-1' }
      })
      transportFactoryQueue.push(replacement)
      connectPanePty(
        ...mockPanePtyArgs(
          createPane(1),
          createManager(1),
          bindPaneAgentTitleMocks(
            createDeps({
              restoredLeafId: LEAF_1,
              restoredPtyIdByLeafId: { [LEAF_1]: 'fresh-pty' }
            }),
            agentTitleMocks3
          )
        )
      )
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)
      expect(replacement.connect).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "codex '-c' 'disable_paste_burst=true' 'resume' 'codex-session-1'",
          resumeProviderSession: { key: 'session_id', id: 'codex-session-1', transcriptPath }
        })
      )
    })

    it('does not choose a non-exact legacy record when same-tab provider sessions differ', async () => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const { connectPanePty } = await import('../connect-pane-pty')
      const agentTitleMocks6 = await vi.importMock<PtyConnectionAgentTitleMocks>(
        '@/lib/agent-status/aggregation/worktree-agent-status'
      )
      const transport = createMockTransport('fresh-pty')
      transport.connect.mockImplementation(async ({ sessionId }: { sessionId?: string }) => {
        if (sessionId) {
          return {
            id: 'fresh-pty',
            coldRestore: { scrollback: 'cold-payload', cwd: '/tmp/wt-1' }
          }
        }
        return 'fresh-pty'
      })
      transportFactoryQueue.push(transport)
      const firstLegacyPaneKey = 'tab-1:2'
      const secondLegacyPaneKey = 'tab-1:3'
      mockStoreState = {
        ...mockStoreState,
        tabsByWorktree: {
          'wt-1': [{ id: 'tab-1', ptyId: 'lost-pty' }]
        },
        settings: {
          ...mockStoreState.settings,
          agentCmdOverrides: {}
        },
        agentStatusByPaneKey: acceptedAgentStatuses(Object.entries({})),
        sleepingAgentSessionsByPaneKey: {
          [firstLegacyPaneKey]: {
            paneKey: firstLegacyPaneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'finish the task',
            state: 'working',
            capturedAt: 1,
            updatedAt: 1
          },
          [secondLegacyPaneKey]: {
            paneKey: secondLegacyPaneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-2' },
            prompt: 'finish another task',
            state: 'working',
            capturedAt: 2,
            updatedAt: 2
          }
        }
      } satisfies StoreState

      const pane = createPane(1)
      const manager = createManager(1)
      const deps = createDeps({
        restoredLeafId: LEAF_1,
        restoredPtyIdByLeafId: { [LEAF_1]: 'lost-pty' }
      })

      connectPanePty(
        pane as never,
        manager as never,
        bindPaneAgentTitleMocks(deps as never, agentTitleMocks6)
      )
      await flushAsyncTicks(20)
      await vi.advanceTimersByTimeAsync(70)

      expect(pane.terminal.write).toHaveBeenCalledWith(
        `${RESET_GRAPHIC_RENDITION}cold-payload`,
        expect.any(Function)
      )
      expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
      expect(transport.connect).not.toHaveBeenCalledWith(
        expect.objectContaining({ command: expect.stringContaining('resume') })
      )
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    })
  })
}
