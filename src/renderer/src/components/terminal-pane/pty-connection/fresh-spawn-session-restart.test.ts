import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'
import { SESSION_RESTART_REFUSED_BEFORE_STOP } from '../../../../../shared/session-restart-refusal'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { bindStartFreshSpawn } from './fresh-spawn-start'
import {
  flushPtySideEffects,
  installIpcPtyWindow,
  restorePtySpecWindow
} from '../pty-transport-test-harness'

function createSession(
  connect: (options?: { callbacks?: unknown }) => Promise<unknown>,
  transport?: ConnectPanePtySession['transport']
) {
  const settled: unknown[] = []
  const getPtyId = vi.fn((): string | null => null)
  const session = {
    pane: { id: 1, leafId: 'leaf', terminal: {} },
    disposed: false,
    authoritativeReattachGeneration: 0,
    remotePtyIncarnationId: null,
    transportStreamGeneration: 1,
    runtimeEnvironmentId: 'test-runtime',
    tabGeneration: 1,
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf',
    pendingSpawnKey: 'tab:leaf',
    pendingReplacedPtyId: null,
    pendingSpawnDeferral: null,
    activePanePtyBinding: null,
    deferredSpawn: null,
    transportConnectInFlightSince: null,
    paneStartup: {
      command: "claude '--resume' 'sess-1'",
      onSessionRestartSettled: (result: unknown) => {
        settled.push(result)
      }
    },
    deps: {
      worktreeId: 'wt',
      tabId: 'tab',
      isVisibleRef: { current: true }
    },
    transport: transport ?? {
      connect: vi.fn(connect),
      attach: vi.fn(),
      getPtyId
    },
    clearPaneMode2031State: vi.fn(),
    clearHiddenOutputRestoreState: vi.fn(),
    resetFreshSpawnFollowOutput: vi.fn(),
    writeInputModeGround: vi.fn(),
    prepareFreshShellViewportForSpawn: vi.fn(),
    captureTransportOutputCallbacks: vi.fn(
      (): {
        generation: number
        callbacks: Record<string, never>
        launchContext: {
          startup: null
          registration: undefined
          status: undefined
          paneStartup: null
        } | null
      } => ({
        generation: 1,
        callbacks: {},
        launchContext: {
          startup: null,
          registration: undefined,
          status: undefined,
          paneStartup: null
        }
      })
    ),
    terminalRecoveryGeneration: 0,
    terminalRecoveryInstance: { id: 'recovery' },
    shouldDeclareHiddenAtSpawn: () => false,
    finishReattachLiveDataDeferral: vi.fn(),
    enterSpawnDeferredSleep: vi.fn(),
    handleReattachResult: vi.fn(async () => true),
    bindActivePanePty: vi.fn(() => {
      settled.push('adopted')
    }),
    reconcilePtySizeAfterSpawn: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    clearRegisteredStartupLaunchConfig: vi.fn(),
    keepUnrunResumeHandle: vi.fn(),
    showSessionRestoredBanner: vi.fn(),
    clearSleepingRecordAfterColdRestoreSpawn: vi.fn(),
    settlePaneAttachAttempt: vi.fn(),
    claimPendingReplacedPtyId: vi.fn(),
    mergeStartupEnvWithPaneIdentity: (env: Record<string, string>) => env,
    reportError: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies every field this fresh spawn reads.
  const typed = session as unknown as ConnectPanePtySession
  bindStartFreshSpawn(typed)
  return { session: typed, settled, getPtyId }
}

describe('fresh spawn session restart settlement', () => {
  it('settles a finished spawn once, after the pane adopts the new process', async () => {
    const { session, settled, getPtyId } = createSession(async () => ({
      id: 'pty-new',
      resumeProviderSession: { id: 'sess-1' }
    }))
    getPtyId.mockReturnValue('pty-new')

    await session.startFreshSpawn()

    expect(settled).toEqual(['adopted', { id: 'pty-new', resumeProviderSession: { id: 'sess-1' } }])
  })

  it('settles a stale generation and a disposed pane instead of leaving them pending', async () => {
    const stale = createSession(async () => ({ id: 'pty-new' }))
    stale.session.captureTransportOutputCallbacks.mockReturnValue({
      generation: 2,
      callbacks: {},
      launchContext: null
    })
    await stale.session.startFreshSpawn()
    expect(stale.settled).toEqual([null])
    expect(stale.session.bindActivePanePty).not.toHaveBeenCalled()

    const closed = createSession(async () => {
      closed.session.disposed = true
      return { id: 'pty-new' }
    })
    expect(await closed.session.startFreshSpawn()).toBe('pty-new')
    expect(closed.settled).toEqual([null])
    expect(closed.session.bindActivePanePty).not.toHaveBeenCalled()
  })

  it('reattaches the predecessor with the spawn callbacks after a wrapped pre-stop refusal', async () => {
    useAppStore.setState({
      tabsByWorktree: { wt: [makeTerminalTab({ id: 'tab', worktreeId: 'wt', generation: 1 })] },
      terminalLayoutsByTabId: {},
      suppressedPtyExitIds: { 'pty-old': true }
    })
    const wrapped = new Error(
      `Error invoking remote method 'pty:spawn': Error: ${SESSION_RESTART_REFUSED_BEFORE_STOP}: prove`
    )
    let callbacks: unknown
    const refused = createSession(async (options) => {
      callbacks = options?.callbacks
      refused.session.pendingReplacedPtyId = null
      throw wrapped
    })
    refused.session.pendingReplacedPtyId = 'pty-old'
    await refused.session.startFreshSpawn()
    expect(refused.session.transport.attach).toHaveBeenCalledWith(
      expect.objectContaining({ existingPtyId: 'pty-old', callbacks })
    )
    expect(refused.session.bindActivePanePty).toHaveBeenCalledWith('pty-old', {
      replacePtyId: 'pty-old'
    })
    expect(refused.settled).toContainEqual({ refusedBeforeStop: true })
    expect(useAppStore.getState().suppressedPtyExitIds['pty-old']).toBeUndefined()
  })

  it('does not adopt a predecessor after the pane generation changes', async () => {
    useAppStore.setState({
      tabsByWorktree: { wt: [makeTerminalTab({ id: 'tab', worktreeId: 'wt', generation: 9 })] },
      terminalLayoutsByTabId: {}
    })
    const stale = createSession(async () => {
      throw new Error(
        `Error invoking remote method 'pty:spawn': Error: ${SESSION_RESTART_REFUSED_BEFORE_STOP}: prove`
      )
    })
    stale.session.pendingReplacedPtyId = 'pty-old'
    stale.getPtyId.mockReturnValue('pty-created')
    await stale.session.startFreshSpawn()
    expect(stale.session.transport.attach).not.toHaveBeenCalled()
    expect(stale.settled).toEqual([null])
  })

  it('reaches reattach through the real IPC transport when spawn rejects a wrapped refusal', async () => {
    const originalWindow = globalThis.window
    const emitData: ((payload: { id: string; data: string }) => void)[] = []
    installIpcPtyWindow(originalWindow, {
      data: (callback) => {
        emitData.push((payload) => callback(payload))
      }
    })
    useAppStore.setState({
      tabsByWorktree: { wt: [makeTerminalTab({ id: 'tab', worktreeId: 'wt', generation: 1 })] },
      terminalLayoutsByTabId: {}
    })
    window.api.pty.spawn = vi
      .fn()
      .mockRejectedValue(
        new Error(
          `Error invoking remote method 'pty:spawn': Error: ${SESSION_RESTART_REFUSED_BEFORE_STOP}: prove`
        )
      )
    const { createIpcPtyTransport } = await import('../pty-transport')
    const transport = createIpcPtyTransport({ resumeOnSelectedAccount: false })
    const received: string[] = []
    const restarted = createSession(async () => null, transport)
    restarted.session.pendingReplacedPtyId = 'pty-old'
    restarted.session.captureTransportOutputCallbacks = () => ({
      generation: 1,
      callbacks: { onData: (data: string) => received.push(data) },
      launchContext: {
        startup: null,
        registration: undefined,
        status: undefined,
        paneStartup: null
      }
    })
    try {
      await restarted.session.startFreshSpawn()
      emitData[0]?.({ id: 'pty-old', data: 'still-live' })
      transport.sendInput('hi', 'driving')
      await flushPtySideEffects()
      expect(received).toEqual(['still-live'])
      expect(transport.getPtyId()).toBe('pty-old')
      expect(window.api.pty.write).toHaveBeenCalledWith('pty-old', 'hi', 'driving')
      expect(restarted.settled).toContainEqual({ refusedBeforeStop: true })
    } finally {
      restorePtySpecWindow(originalWindow)
    }
  })

  it('reports deferral as pending and a missing result as finished', async () => {
    const deferred = createSession(async () => {
      deferred.session.pendingSpawnDeferral = 'pressure'
      return null
    })
    await deferred.session.startFreshSpawn()
    expect(deferred.settled).toEqual([{ deferred: true }])
    expect(deferred.session.enterSpawnDeferredSleep).toHaveBeenCalled()

    const missing = createSession(async () => null)
    await missing.session.startFreshSpawn()
    expect(missing.settled).toEqual([null])
  })
})
