import { bindPtyConnectionTestMocks } from './pty-connection-mocks.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  bindsPaneInStore,
  expectNoWindowStart,
  expectWindowStartAskedMain,
  mainLayoutApplyTransport,
  mainStartsPaneAs
} from './pty-connection-test-main-pane-start-fixtures'
import { createDeferred, flushAsyncTicks } from './pty-connection-test-async'
import {
  LEAF_2,
  createMockTransport,
  createPane,
  createManager
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { connectPanePty } from './pty-connection'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

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

  function connectHiddenPane(restoredPtyId: string | null): {
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
    return { transport, binding: connectPane(deps), isVisibleRef }
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

  function connectPane(deps: ReturnType<typeof buildPaneConnectionDeps>): HiddenPaneBinding {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixtures implement the pane, manager and deps members connectPanePty reads.
    const args = [createPane(2), createManager(2), deps] as unknown as Parameters<
      typeof connectPanePty
    >
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: connectPanePty returns the PanePtyBinding, which has both methods.
    return connectPanePtyRef!(...args) as unknown as HiddenPaneBinding
  }

  function setHostLiveness(isLive: boolean | null): void {
    vi.mocked(window.api.pty.hasPty).mockResolvedValue(isLive)
  }

  function resumeCommands(transport: MockTransport): (string | undefined)[] {
    return transport.connect.mock.calls.map((call) => call[0]?.command)
  }

  /** Switch on: the window asked main to start the pane and attached to main's terminal. */
  async function expectAttachedToMainStart(transport: MockTransport): Promise<void> {
    await expectWindowStartAskedMain(transport, PANE_KEY, mockStoreState)
    expect(transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: MAIN_PTY_ID, attachOnlyView: true })
    )
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
      connectPanePtyRef = (await import('./pty-connection')).connectPanePty
      ;(await mainLayoutApplyTransport()).reset()
      // Switch on: main's start of the pane binds it to `pty-main`.
      await mainStartsPaneAs({
        ptyId: MAIN_PTY_ID,
        bind: bindsPaneInStore(() => mockStoreState, 'tab-1', LEAF_2)
      })
    })

    afterEach(async () => {
      await restoreTerminalTestGlobals()
    })

    it('waits for the reveal before resuming a hidden pane that has no PTY to reattach', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)

      expect(transport.connect).not.toHaveBeenCalled()
      expect(mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectAttachedToMainStart(transport)
        return
      }
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('holds a hidden reattach the host reports gone, then reattaches it on reveal', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { transport, binding, isVisibleRef } = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)

      expect(transport.connect).not.toHaveBeenCalled()

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      // The reveal takes the same reattach a visible pane would, so the host restores its scrollback.
      expect(transport.connect.mock.calls[0]?.[0]).toMatchObject({ sessionId: DEAD_SESSION_ID })
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // The reveal's reattach is a view: main's start, not the window, resumes the agent.
        expect(transport.connect.mock.calls[0]?.[0]).toMatchObject({ attachOnlyView: true })
        expectNoWindowStart(transport, mockStoreState)
        return
      }
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it.each([
      ['live', true],
      ['unverifiable', null]
    ] as const)('reattaches a hidden %s session at mount', async (_label, isLive) => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(isLive)
      const { transport } = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.connect.mock.calls[0]?.[0]).toMatchObject({ sessionId: DEAD_SESSION_ID })
    })

    it('resumes a hidden pane at mount when a background mount asked for its tab', async () => {
      seedSleepingPane(null)
      const { requestSleepingAgentWakeOnMount } = await import('@/lib/sleeping-agent-wake-requests')
      requestSleepingAgentWakeOnMount('wt-1', ['tab-1'])
      const { transport } = connectHiddenPane(null)
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectAttachedToMainStart(transport)
        return
      }
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('resumes a held hidden pane immediately on a phone wake', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { transport, binding } = connectHiddenPane(DEAD_SESSION_ID)
      await flushAsyncTicks(10)
      expect(transport.connect).not.toHaveBeenCalled()

      const claimed = new Set<string>()
      expect(binding.wakeHibernatedAgentIfArmed(claimed)).not.toBeNull()
      expect(binding.wakeHibernatedAgentIfArmed(claimed)).toBeNull()
      await flushAsyncTicks(10)

      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(transport.connect.mock.calls[0]?.[0]).toMatchObject({ sessionId: DEAD_SESSION_ID })
    })

    it('owns its record while held, so an activation sweep does not relaunch it elsewhere', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const { binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
    })

    it('keeps a background wake released through a failed reattach fallback', async () => {
      seedSleepingPane(DEAD_SESSION_ID)
      setHostLiveness(false)
      const { requestSleepingAgentWakeOnMount } = await import('@/lib/sleeping-agent-wake-requests')
      requestSleepingAgentWakeOnMount('wt-1', ['tab-1'])
      const transport = createMockTransport()
      // The reattach comes back with no PTY, so the pane falls back to a fresh resume.
      transport.connect.mockResolvedValueOnce(undefined).mockResolvedValue('resumed-pty')
      transportFactoryQueue.push(transport)
      connectPane(
        buildPaneConnectionDeps(() => mockStoreState, {
          restoredLeafId: LEAF_2,
          restoredPtyIdByLeafId: { [LEAF_2]: DEAD_SESSION_ID },
          isVisibleRef: { current: false }
        })
      )
      await flushAsyncTicks(20)

      expect(transport.connect).toHaveBeenCalledTimes(2)
      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        // The failed reattach asks main to start the pane; the second connect attaches to it.
        await expectAttachedToMainStart(transport)
        return
      }
      expect(resumeCommands(transport)[1]).toContain("'resume' 'codex-session-1'")
    })

    it('keeps owning its record while the woken resume is still starting', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      const spawn = createDeferred<string>()
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      transport.connect.mockImplementation(() =>
        spawn.promise.then((ptyId) => {
          transport.getPtyId.mockReturnValue(ptyId)
          return ptyId
        })
      )
      await flushAsyncTicks(10)

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)

      spawn.resolve('resumed-pty')
      await flushAsyncTicks(10)
      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(false)
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
        })
      )
      await flushAsyncTicks(10)
      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)
      expect(transport.connect).toHaveBeenCalledTimes(1)

      // Hibernation sleeps the hidden pane again: its own wake, which the activation sweep may clean around.
      isVisibleRef.current = false
      seedSleepingPane(null, { state: 'done', origin: 'worktree-sleep' })
      // Switch on: the pane runs main's terminal, so that is what the sleep ends.
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

    it('resumes a held pane whose record was re-captured for the same session', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
      await flushAsyncTicks(10)
      const held = mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY]!
      mockStoreState.sleepingAgentSessionsByPaneKey[PANE_KEY] = { ...held, updatedAt: 2 }

      isVisibleRef.current = true
      binding.noteVisibilityResume()
      await flushAsyncTicks(10)

      if (ORCA_LAYOUT_OWNER_IS_MAIN) {
        await expectAttachedToMainStart(transport)
        return
      }
      expect(resumeCommands(transport)[0]).toContain("'resume' 'codex-session-1'")
    })

    it('drops a held wake once the record names a different session', async () => {
      seedSleepingPane(null)
      const { transport, binding, isVisibleRef } = connectHiddenPane(null)
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
      const { transport, binding, isVisibleRef } = connectHiddenPane(DEAD_SESSION_ID)
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

    it('keeps holding when an exit lands that its held wake did not start', async () => {
      seedSleepingPane(null)
      const { isPaneSpawnDeferred } = await import('@/lib/pane-spawn-deferral-registry')
      connectHiddenPane(null)
      await flushAsyncTicks(10)
      const onPtyExit = createdTransportOptions[0]?.onPtyExit
      if (typeof onPtyExit !== 'function') {
        throw new Error('expected the transport exit handler')
      }

      onPtyExit('stale-restored-pty')
      await flushAsyncTicks(10)

      expect(isPaneSpawnDeferred(PANE_KEY)).toBe(true)
    })
  })
}
