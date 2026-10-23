import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import { UUID_RE } from './pty-connection-test-constants'
import { temporarilySetNavigatorUserAgent } from './pty-connection-test-dom'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

    it('re-runs the resume command when a hibernated local session reattaches with no payload', async () => {
      // Why: the daemon drops startup commands on reattach, so a passive hibernation record must replace a contentless adopted shell.
      const pendingTimeouts: (() => void)[] = []
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = vi.fn((fn: () => void) => {
        pendingTimeouts.push(fn)
        return 999 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout

      try {
        const { connectPanePty } = await import('./pty-connection')
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
              // Mirrors the user's scenario: a stopped/completed agent that hibernated.
              state: 'done',
              origin: 'worktree-sleep',
              capturedAt: 1,
              updatedAt: 1
            }
          }
        } as StoreState
        const pane = createPane(2)
        const manager = createManager(2)
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
        })
        vi.mocked(window.api.pty.declarePendingPaneSerializer)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2)

        connectPanePty(pane as never, manager as never, deps as never)
        await flushAsyncTicks(20)
        for (const fn of pendingTimeouts) {
          fn()
        }
        await flushAsyncTicks(10)

        expect(transport.disconnect).toHaveBeenCalledTimes(1)
        expect(transport.connect).toHaveBeenCalledTimes(2)
        expect(transport.connect).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            command: "codex 'resume' 'codex-session-1'",
            env: expect.objectContaining({
              ORCA_PANE_KEY: paneKey,
              ORCA_AGENT_LAUNCH_TOKEN: expect.stringMatching(new RegExp(`^${UUID_RE}$`))
            })
          })
        )
        // The dead session is not adopted as the pane's live PTY.
        expect(deps.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
        expect(deps.clearTabPtyId).toHaveBeenCalledWith('tab-1', 'restored-session')
        expect(deps.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(2, 'restored-session')
        expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'fresh-resume-pty')
        expect(mockStoreState.clearSleepingAgentSession).toHaveBeenCalledWith(paneKey)
        expect(window.api.pty.clearPendingPaneSerializer).toHaveBeenCalledWith(paneKey, 1)
      } finally {
        globalThis.setTimeout = originalSetTimeout
      }
    })

    // Regression (#12320): a cold restore after reboot typed PowerShell single quotes into
    // cmd.exe tabs, so the agent CLI rejected the resume argv ("unexpected argument").
    async function runWindowsColdRestoreResume(args: {
      terminalWindowsShell: string
      tabShellOverride?: string
    }): Promise<string | undefined> {
      const restoreNavigator = temporarilySetNavigatorUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      )
      const pendingTimeouts: (() => void)[] = []
      const originalSetTimeout = globalThis.setTimeout
      globalThis.setTimeout = vi.fn((fn: () => void) => {
        pendingTimeouts.push(fn)
        return 999 as unknown as ReturnType<typeof setTimeout>
      }) as unknown as typeof setTimeout

      try {
        const { connectPanePty } = await import('./pty-connection')
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
          tabsByWorktree: {
            'wt-1': [
              {
                id: 'tab-1',
                ptyId: 'restored-session',
                ...(args.tabShellOverride ? { shellOverride: args.tabShellOverride } : {})
              }
            ]
          },
          settings: {
            ...mockStoreState.settings,
            agentCmdOverrides: {},
            terminalWindowsShell: args.terminalWindowsShell
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
        } as StoreState
        const deps = createDeps({
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
        })
        vi.mocked(window.api.pty.declarePendingPaneSerializer)
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2)

        connectPanePty(createPane(2) as never, createManager(2) as never, deps as never)
        await flushAsyncTicks(20)
        for (const fn of pendingTimeouts) {
          fn()
        }
        await flushAsyncTicks(10)

        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The transport connect spy records the command string supplied by the cold-restore path.
        return (transport.connect.mock.calls.at(-1)?.[0] as { command?: string } | undefined)
          ?.command
      } finally {
        globalThis.setTimeout = originalSetTimeout
        restoreNavigator()
      }
    }

    it('quotes a cold-restore resume command for a cmd.exe Windows tab', async () => {
      await expect(runWindowsColdRestoreResume({ terminalWindowsShell: 'cmd.exe' })).resolves.toBe(
        'codex "resume" "codex-session-1"'
      )
    })

    it('prefers the tab shell override over the global Windows shell on cold restore', async () => {
      await expect(
        runWindowsColdRestoreResume({
          terminalWindowsShell: 'powershell.exe',
          tabShellOverride: 'cmd.exe'
        })
      ).resolves.toBe('codex "resume" "codex-session-1"')
    })

    it('keeps PowerShell quoting for a cold-restore resume on a PowerShell Windows tab', async () => {
      await expect(
        runWindowsColdRestoreResume({ terminalWindowsShell: 'powershell.exe' })
      ).resolves.toBe("codex 'resume' 'codex-session-1'")
    })

    async function expectLiveNoteKeepsContentlessReattach(
      state: 'working' | 'done'
    ): Promise<void> {
      const { connectPanePty } = await import('./pty-connection')
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
        sleepingAgentSessionsByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            agent: 'codex',
            providerSession: { key: 'session_id', id: 'codex-session-1' },
            prompt: 'finish the task',
            state: 'working',
            origin: 'live',
            capturedAt: 1,
            updatedAt: 1
          }
        }
      } as StoreState
      Object.assign(mockStoreState.sleepingAgentSessionsByPaneKey[paneKey] ?? {}, { state })
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.disconnect).not.toHaveBeenCalled()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    }

    // Why: a live note is the idle anchor of a running pane, done or not, never hibernation evidence.
    it.each(['working', 'done'] as const)(
      'keeps a contentless reattach when a live-origin %s note represents a running session',
      expectLiveNoteKeepsContentlessReattach
    )

    it('keeps a contentless reattach when a live status supersedes passive sleep evidence', async () => {
      const { connectPanePty } = await import('./pty-connection')
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
        agentStatusByPaneKey: {
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
        },
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
      } as StoreState
      const pane = createPane(2)
      const manager = createManager(2)
      const deps = createDeps({
        restoredLeafId: LEAF_2,
        restoredPtyIdByLeafId: { [LEAF_2]: 'restored-session' }
      })

      connectPanePty(pane as never, manager as never, deps as never)
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.disconnect).not.toHaveBeenCalled()
      expect(deps.syncPanePtyLayoutBinding).toHaveBeenCalledWith(2, 'restored-session')
      expect(mockStoreState.clearSleepingAgentSession).not.toHaveBeenCalled()
    })
  })
}
