import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import {
  AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS,
  armAgentStatusStartupSnapshot,
  resetAgentStatusStartupSnapshotGate,
  settleAgentStatusStartupSnapshot
} from '../../../hooks/ipc-events/agent-status-startup-snapshot-gate'

const SESSION_ID = 'pty-restored-1'
const RESUME = {
  agent: 'opencode',
  command: 'opencode --session ses_1',
  env: { ORCA_AGENT_LAUNCH_TOKEN: 'tok' },
  launchConfig: { agentCommand: 'opencode' },
  launchToken: 'tok',
  resumeProviderSession: { key: 'session_id', id: 'ses_1' }
}

function buildSession(): {
  session: ConnectPanePtySession
  connect: ReturnType<typeof vi.fn>
  buildStartup: ReturnType<typeof vi.fn>
} {
  const connect = vi.fn(() => new Promise(() => {}))
  const transport = { connect, getPtyId: () => null }
  const buildStartup = vi.fn(() => null)
  const session = {
    allowInitialIdleCacheSeed: false,
    disposed: false,
    runtimeEnvironmentId: 'env-1',
    pane: { id: 'pane-1' },
    cacheKey: 'tab-1:leaf-1',
    cols: 80,
    rows: 24,
    paneStartup: null,
    directSshRetryAttempt: undefined,
    transport,
    transportConnectInFlightSince: null,
    deps: {
      paneTransportsRef: { current: new Map([['pane-1', transport]]) },
      tabId: 'tab-1',
      worktreeId: 'wt-1'
    },
    prepaintParkedSshSnapshot: vi.fn(),
    buildColdRestoreAgentResumeStartup: buildStartup,
    captureTransportOutputCallbacks: vi.fn(() => ({ generation: 1, callbacks: {} })),
    beginReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    mergeStartupEnvWithPaneIdentity: (env: Record<string, string>) => env,
    armDirectSshPaneRetryTimeout: vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bag implements only the members startDeferredSessionReattach reads before connect.
  } as unknown as ConnectPanePtySession
  return { session, connect, buildStartup }
}

beforeEach(() => {
  resetAgentStatusStartupSnapshotGate()
  vi.useRealTimers()
})

afterEach(() => {
  resetAgentStatusStartupSnapshotGate()
  vi.useRealTimers()
})

describe('deferred reattach waits for the startup status snapshot', () => {
  it('connects immediately when no startup snapshot is in flight', async () => {
    const { session, connect, buildStartup } = buildSession()
    buildStartup.mockReturnValue(RESUME)

    startDeferredSessionReattach(session, SESSION_ID)
    await Promise.resolve()

    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        command: RESUME.command,
        resumeProviderSession: RESUME.resumeProviderSession,
        launchAgent: RESUME.agent
      })
    )
  })

  it('holds the first pane until the snapshot is applied, then resumes that session', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    const { session, connect, buildStartup } = buildSession()

    startDeferredSessionReattach(session, SESSION_ID)
    await Promise.resolve()
    expect(connect).not.toHaveBeenCalled()
    expect(buildStartup).not.toHaveBeenCalled()
    expect(session.transportConnectInFlightSince).toEqual(expect.any(Number))

    buildStartup.mockReturnValue(RESUME)
    settleAgentStatusStartupSnapshot(epoch)
    await Promise.resolve()
    await Promise.resolve()

    expect(buildStartup).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        command: RESUME.command,
        resumeProviderSession: RESUME.resumeProviderSession
      })
    )
  })

  it('does not connect a pane disposed while the snapshot was in flight', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    const { session, connect, buildStartup } = buildSession()
    buildStartup.mockReturnValue(RESUME)
    startDeferredSessionReattach(session, SESSION_ID)
    session.disposed = true

    settleAgentStatusStartupSnapshot(epoch)
    await Promise.resolve()
    await Promise.resolve()

    expect(connect).not.toHaveBeenCalled()
    expect(buildStartup).not.toHaveBeenCalled()
    expect(session.transportConnectInFlightSince).toBeNull()
  })

  it('does not connect after the pane transport was replaced during the wait', async () => {
    const epoch = armAgentStatusStartupSnapshot()
    const { session, connect, buildStartup } = buildSession()
    buildStartup.mockReturnValue(RESUME)
    startDeferredSessionReattach(session, SESSION_ID)
    session.deps.paneTransportsRef.current.set(session.pane.id, { connect: vi.fn() } as never)

    settleAgentStatusStartupSnapshot(epoch)
    await Promise.resolve()
    await Promise.resolve()

    expect(connect).not.toHaveBeenCalled()
    expect(session.transportConnectInFlightSince).toBeNull()
  })

  it('connects without a resume command when the snapshot does not arrive in time', async () => {
    vi.useFakeTimers()
    armAgentStatusStartupSnapshot()
    const { session, connect, buildStartup } = buildSession()

    startDeferredSessionReattach(session, SESSION_ID)
    await vi.advanceTimersByTimeAsync(AGENT_STATUS_STARTUP_SNAPSHOT_WAIT_MS - 1)
    expect(connect).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(buildStartup).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('command')
    expect(connect.mock.calls[0]?.[0]).not.toHaveProperty('resumeProviderSession')
  })
})
