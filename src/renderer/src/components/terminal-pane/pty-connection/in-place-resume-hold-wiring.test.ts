// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { isPaneResumingInPlace } from '@/lib/pane-spawn-deferral-registry'
import { bindDeferredColdRestoreAndSnapshot } from './deferred-cold-restore-and-snapshot'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

vi.mock('../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

const RECORD_PANE_KEY = 'tab:leaf'

function resumeStartup(): ColdRestoreAgentResumeStartup {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the starts read only the command, agent, launch config and the record's pane key.
  return {
    command: 'claude --resume c1',
    agent: 'claude',
    launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
    launchToken: 'token-1',
    sleepingRecordEntry: { paneKey: RECORD_PANE_KEY, record: {} }
  } as unknown as ColdRestoreAgentResumeStartup
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** A paired server's pane, which the window still starts itself; main starts every other one. */
const PAIRED_SERVER = 'env-paired'

function createSession(connect: () => Promise<unknown>, runtimeEnvironmentId: string | null) {
  const transport = { connect: vi.fn(connect), getPtyId: () => null }
  const fixture = {
    pane: { id: 1, leafId: 'leaf' },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    runtimeEnvironmentId,
    deps: {
      tabId: 'tab',
      worktreeId: 'wt',
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    buildColdRestoreAgentResumeStartup: resumeStartup,
    captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
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
    cacheKey: RECORD_PANE_KEY
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture provides every session field the two starts read.
  return fixture as unknown as ConnectPanePtySession
}

describe('a start that resumes a record marks its pane as resuming in place (layout-owner build)', () => {
  let bridge: ReturnType<typeof registerAgentStatusStartupSnapshot>
  beforeEach(() => {
    bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { pty: { declarePendingPaneSerializer: vi.fn().mockResolvedValue(null) } }
    })
  })
  afterEach(() => bridge.dispose())

  it('the reattach that carries the resume holds the mark until it settles', async () => {
    const connected = deferred<unknown>()
    const session = createSession(() => connected.promise, PAIRED_SERVER)

    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(session.transport.connect).toHaveBeenCalled())
    expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(true)

    connected.resolve({ id: 'restored-pty' })
    await vi.waitFor(() => expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(false))
  })

  it('the fresh start that resumes the record holds the mark until it settles', async () => {
    const session = createSession(() => Promise.resolve(null), PAIRED_SERVER)
    bindDeferredColdRestoreAndSnapshot(session)
    const spawned = deferred<string | null>()
    session.startFreshSpawn = vi.fn(() => spawned.promise)

    const start = session.spawnColdRestoreAgentResume(resumeStartup())
    expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(true)

    spawned.resolve('fresh-pty')
    await start
    await vi.waitFor(() => expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(false))
  })
  it('a pane main starts: its reattach is a view that carries no resume and holds no mark', async () => {
    const connected = deferred<unknown>()
    const session = createSession(() => connected.promise, null)

    startDeferredSessionReattach(session, 'restored-pty')
    await vi.waitFor(() => expect(session.transport.connect).toHaveBeenCalled())
    expect(session.transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'restored-pty', attachOnlyView: true })
    )
    expect(session.transport.connect).toHaveBeenCalledWith(
      expect.not.objectContaining({ command: expect.anything() })
    )
    expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(false)

    connected.resolve({ id: 'restored-pty' })
    await vi.waitFor(() => expect(session.handleReattachResult).toHaveBeenCalled())
    expect(isPaneResumingInPlace(RECORD_PANE_KEY)).toBe(false)
  })
})
