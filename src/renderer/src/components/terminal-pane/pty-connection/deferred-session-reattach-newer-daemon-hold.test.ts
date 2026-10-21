// @vitest-environment happy-dom

import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../shared/newer-daemon-hold'
import { newerDaemonHoldStore, reopenHeldTerminals } from '../newer-daemon-hold-state'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

const REFUSAL = `Error invoking remote method 'pty:spawn': Error: ${NEWER_DAEMON_HOLD_ERROR}`

function createSession(opts: { runtimeEnvironmentId?: string } = {}) {
  let onError: (message: string) => void = () => {}
  let next: 'refuse' | 'reattach' | 'throw' = 'refuse'
  const transport = {
    connect: vi.fn(async () => {
      if (next === 'throw') {
        throw new Error('spawn failed')
      }
      if (next === 'refuse') {
        onError(REFUSAL)
        return undefined
      }
      return { id: 'restored-pty', coldRestore: { scrollback: 'x', cwd: '/', cols: 80, rows: 24 } }
    }),
    getPtyId: () => null
  }
  const fixture = {
    pane: { id: 1, leafId: 'leaf', terminal: { options: { disableStdin: false } } },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    runtimeEnvironmentId: opts.runtimeEnvironmentId ?? null,
    waitTeardowns: new Array<() => void>(),
    writeReplayData: vi.fn(),
    deps: {
      restoredViewportBlankingPanesRef: { current: new Set<number>() },
      tabId: 'tab',
      worktreeId: 'wt',
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    buildColdRestoreAgentResumeStartup: () => ({ command: 'claude --resume c1', agent: 'claude' }),
    captureTransportOutputCallbacks: (reportError: (message: string) => void) => {
      onError = reportError
      return { generation: 1, callbacks: {} }
    },
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    mergeStartupEnvWithPaneIdentity: (env: Record<string, string>) => env,
    handleReattachResult: vi.fn().mockResolvedValue(true),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn().mockResolvedValue('fresh-pty'),
    reportError: vi.fn(),
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides every session field read by deferred reattach and the hold.
  const session = fixture as unknown as ConnectPanePtySession
  return { fixture, session, transport, nextConnect: (mode: typeof next) => (next = mode) }
}

const isHeld = (): boolean => Object.keys(newerDaemonHoldStore.getState().panes).length > 0

describe('restored pane refused for a newer daemon', () => {
  let bridge: ReturnType<typeof registerAgentStatusStartupSnapshot>
  beforeEach(() => {
    vi.clearAllMocks()
    newerDaemonHoldStore.setState({ panes: {} })
    bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        pty: {
          declarePendingPaneSerializer: vi.fn().mockResolvedValue(null),
          readNewerDaemonHeldScreen: vi.fn().mockResolvedValue(null),
          reopenNewerDaemonTerminals: vi.fn().mockResolvedValue({ reopened: true })
        }
      }
    })
  })
  afterEach(() => bridge.dispose())

  it('holds the pane read-only instead of reporting an error or starting a fresh agent', async () => {
    const { fixture, session, transport } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(isHeld()).toBe(true))
    expect(fixture.pane.terminal.options.disableStdin).toBe(true)
    expect(transport.connect).toHaveBeenCalledTimes(1)
    expect(fixture.reportError).not.toHaveBeenCalled()
    expect(fixture.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it('reconnects the same session through the normal path once released, and counts it', async () => {
    const { fixture, session, transport, nextConnect } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(isHeld()).toBe(true))
    nextConnect('reattach')
    await reopenHeldTerminals('tab:leaf')
    expect(transport.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'restored-pty', command: 'claude --resume c1' })
    )
    expect(fixture.pane.terminal.options.disableStdin).toBe(false)
    expect(toast.success).toHaveBeenCalledWith('Reopened 1 terminal', {
      description: '1 agent session resumed.'
    })
  })

  it('shows the saved screen while held and clears it before reconnecting', async () => {
    vi.mocked(window.api.pty.readNewerDaemonHeldScreen).mockResolvedValue({
      scrollback: 'old output',
      cols: 80,
      rows: 24
    })
    const { fixture, session, nextConnect } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(fixture.writeReplayData).toHaveBeenCalledWith('old output'))
    nextConnect('reattach')
    await reopenHeldTerminals('tab:leaf')
    expect(fixture.writeReplayData).toHaveBeenLastCalledWith('\x1b[0m\x1b[2J\x1b[3J\x1b[H')
  })

  it('leaves a screen the layout restore already painted alone', async () => {
    const { fixture, session, nextConnect } = createSession()
    fixture.deps.restoredViewportBlankingPanesRef.current.add(1)
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(isHeld()).toBe(true))
    nextConnect('reattach')
    await reopenHeldTerminals('tab:leaf')
    expect(window.api.pty.readNewerDaemonHeldScreen).not.toHaveBeenCalled()
    expect(fixture.writeReplayData).not.toHaveBeenCalled()
  })

  it('counts a released pane that falls back to a fresh session as reopened', async () => {
    const { fixture, session, nextConnect } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(isHeld()).toBe(true))
    nextConnect('throw')
    await reopenHeldTerminals('tab:leaf')
    expect(fixture.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledWith('Reopened 1 terminal', {
      description: '1 agent session resumed.'
    })
  })

  it('treats a paired host refusal as an ordinary error, never a local hold', async () => {
    const { fixture, session, transport } = createSession({ runtimeEnvironmentId: 'env-1' })
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(fixture.reportError).toHaveBeenCalledWith(REFUSAL))
    expect(isHeld()).toBe(false)
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })

  it('does not release a pane that unmounted while held', async () => {
    const { fixture, session, transport } = createSession()
    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(isHeld()).toBe(true))
    for (const teardown of fixture.waitTeardowns) {
      teardown()
    }
    await reopenHeldTerminals('tab:leaf')
    expect(transport.connect).toHaveBeenCalledTimes(1)
  })
})
