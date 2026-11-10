import { bindPtyConnectionTestMocks } from '../test-fixtures/pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectNoWindowStart,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from '../test-fixtures/pty-connection-test-main-pane-start-fixtures'
import { createDeferred, flushAsyncTicks } from '../test-fixtures/pty-connection-test-async'
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

import type { connectPanePty } from '../connect-pane-pty'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../test-fixtures/pty-connection-test-environment'
import { mockPanePtyArgs } from '../test-fixtures/pty-connection-test-connect-mock-pane'

type HiddenPaneBinding = {
  noteVisibilityResume: () => void
  wakeHibernatedAgentIfArmed: (claimed?: Set<string>) => string | null
}

const PANE_KEY = makePaneKey('tab-1', LEAF_2)
const DEAD_SESSION_ID = 'wt-1@@dead-session'
const MAIN_PTY_ID = 'pty-main'

/** After a relaunch: one sleeping agent pane with no live PTY. */
export function registerPtyConnectionHiddenSleepingResumeTests(): void {
  let mockStoreState: StoreState
  let transportFactoryQueue: MockTransport[] = []
  let createdTransportOptions: Record<string, unknown>[] = []
  let storeSubscribers: ((state: StoreState) => void)[] = []
  let connectPanePtyRef: typeof connectPanePty | null = null

  function seedSleepingPane(
    restoredPtyId: string | null,
    record: Record<string, unknown> = {}
  ): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture state carries every field connectPanePty reads; the tab and record literals are partial by design.
    mockStoreState = {
      ...mockStoreState,
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1', ptyId: restoredPtyId }] },
      ptyIdsByTabId: { 'tab-1': [] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_2 },
          activeLeafId: LEAF_2,
          expandedLeafId: null,
          ptyIdsByLeafId: restoredPtyId ? { [LEAF_2]: restoredPtyId } : {}
        }
      },
      settings: { ...mockStoreState.settings, agentCmdOverrides: {} },
      agentStatusByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {
        [PANE_KEY]: {
          paneKey: PANE_KEY,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session-1' },
          prompt: 'finish the task',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1,
          origin: 'quit',
          ...record
        }
      }
    } as StoreState
  }

  function connectHiddenPane(
    restoredPtyId: string | null,
    agentTitleMocks: PtyConnectionAgentTitleMocks
  ): {
    transport: MockTransport
    binding: HiddenPaneBinding
    isVisibleRef: { current: boolean }
  } {
    const transport = createResumingTransport()
    transportFactoryQueue.push(transport)
    const isVisibleRef = { current: false }
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      restoredLeafId: LEAF_2,
      restoredPtyIdByLeafId: restoredPtyId ? { [LEAF_2]: restoredPtyId } : {},
      isVisibleRef
    })
    return { transport, binding: connectPane(deps, agentTitleMocks), isVisibleRef }
  }

  /** A pane transport with no PTY until a connect binds one, as after a relaunch. */
  function createResumingTransport(): MockTransport {
    const transport = createMockTransport()
    transport.connect.mockImplementation(async (opts: { sessionId?: string }) => {
      const ptyId = opts.sessionId ?? 'resumed-pty'
      transport.getPtyId.mockReturnValue(ptyId)
      return opts.sessionId ? { id: ptyId } : ptyId
    })
    return transport
  }

  function connectPane(
    deps: ReturnType<typeof buildPaneConnectionDeps>,
    agentTitleMocks: PtyConnectionAgentTitleMocks
  ): HiddenPaneBinding {
    const args = mockPanePtyArgs(createPane(2), createManager(2), deps)
    bindPaneAgentTitleMocks(args[2], agentTitleMocks)

    return connectPanePtyRef!(...args)
  }

  function setHostLiveness(isLive: boolean | null): void {
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(isLive)
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
      connectPanePtyRef = (await import('../connect-pane-pty')).connectPanePty
      ;(await mainLayoutApplyTransport()).reset()
      await mainStartsPaneAs({
        ptyId: MAIN_PTY_ID,
        bind: bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2)
      })
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('does not count a later in-session sleep of the woken pane as held', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const isVisibleRef = { current: false }
      const transport = createResumingTransport()
      transportFactoryQueue.push(transport)
      const binding = connectPane(
        buildPaneConnectionDeps(() => mockStoreState, {
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: {},
          consumeSuppressedPtyExit: vi.fn(() => true),
          isVisibleRef
        }),
        await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
      )
      await flushAsyncTicks(10)
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Hibernation sleeps the hidden pane again: its own wake, which the activation sweep may clean around.
      isVisibleRef.current = false
      seedSleepingPane(null, { state: 'done', origin: 'worktree-sleep' })
      const resumedPtyId = ORCA_LAYOUT_OWNER_IS_MAIN ? MAIN_PTY_ID : 'resumed-pty'
      mockStoreState.suppressedPtyExitIds[resumedPtyId] = true
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      if (typeof onPtyExit !== 'function') {
        throw new Error('expected the transport exit handler')
      }
      onPtyExit(resumedPtyId)
      await flushAsyncTicks(10)

      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
      // The in-session wake is still armed, so the reveal resumes the pane again.
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(2)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        expect((await mainLayoutApplyTransport()).sentOfType('startPane')).toHaveLength(2)
        expectNoWindowStart(transport, mockStoreState)
      }
    })

    it('drops a held wake once the record names a different session', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(
        null,
        await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
      )
      await flushAsyncTicks(10)
      const held = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
      mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = {
        ...held,
        providerSession: { key: 'session_id', id: 'codex-session-2' }
      }

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).not.toHaveBeenCalled()
    })

    it('keeps holding while a woken reattach falls back to a fresh resume', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const { transport, binding, isVisibleRef } = connectHiddenPane(
        DEAD_SESSION_ID,
        await vi.importMock<PtyConnectionAgentTitleMocks>(
          '@/lib/agent-status/aggregation/worktree-agent-status'
        )
      )
      await flushAsyncTicks(10)
      const fallback = createDeferred<string>()
      // The reattach comes back with no PTY; the fallback spawn is still starting.
      transport.connect.mockResolvedValueOnce(undefined).mockImplementationOnce(() =>
        fallback.promise.then((ptyId) => {
          transport.getPtyId.mockReturnValue(ptyId)
          return ptyId
        })
      )

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(20)
      expect(transport.connect).toHaveBeenCalledTimes(2)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      fallback.resolve('resumed-pty')
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })
  })
}
