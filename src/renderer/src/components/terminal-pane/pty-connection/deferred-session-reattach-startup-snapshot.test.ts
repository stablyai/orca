import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAgentStatusStartupSnapshot } from '@/hooks/ipc-events/agent-status-startup-snapshot'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

vi.mock('../terminal-lifecycle-diagnostics', () => ({ warnTerminalLifecycleAnomaly: vi.fn() }))
vi.mock('./direct-ssh-reattach-recovery', () => ({ recoverUnverifiableDirectSshReattach: vi.fn() }))
vi.mock('./paired-parked-terminal-restore', () => ({ isRemoteRuntimePtyId: () => false }))
vi.mock('./pty-connect-limits', () => ({
  recordPtyConnectDiagnostic: vi.fn(),
  isSshSessionGoneError: () => false
}))

function createSession() {
  let startup: {
    command: string
    agent: string
    resumeProviderSession: { key: string; id: string }
  } | null = null
  const transport = { connect: vi.fn().mockResolvedValue(null), getPtyId: () => 'restored-pty' }
  const fixture = {
    pane: { id: 1 },
    transport,
    disposed: false,
    transportStreamGeneration: 1,
    deps: { paneTransportsRef: { current: new Map([[1, transport]]) } },
    buildColdRestoreAgentResumeStartup: () => startup,
    prepaintParkedSshSnapshot: vi.fn(),
    captureTransportOutputCallbacks: () => ({ generation: 1, callbacks: {} }),
    beginReattachLiveDataDeferral: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => true,
    handleReattachResult: vi.fn().mockResolvedValue(true),
    armDirectSshPaneRetryTimeout: vi.fn(),
    reportError: vi.fn(),
    isCapturedDirectSshReattachCurrent: () => true,
    cols: 80,
    rows: 24,
    cacheKey: 'tab:leaf'
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture provides every session field read by deferred reattach; unrelated installers are not exercised.
  const session = fixture as unknown as ConnectPanePtySession
  return {
    fixture,
    session,
    transport,
    replay: () => {
      startup = {
        command: "cursor-agent '--resume' 'conversation-742'",
        agent: 'cursor',
        resumeProviderSession: { key: 'conversation_id', id: 'conversation-742' }
      }
    }
  }
}

describe('cold reattach waits for host identity replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      api: { pty: { declarePendingPaneSerializer: vi.fn().mockResolvedValue(null) } }
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('connects synchronously when host replay already applied before pane registration', () => {
    const bridge = registerAgentStatusStartupSnapshot()
    bridge.settle()
    const { session, fixture, transport } = createSession()
    fixture.deps.paneTransportsRef.current.clear()
    startDeferredSessionReattach(session, 'live-pty')
    expect(transport.connect).toHaveBeenCalledOnce()
    fixture.deps.paneTransportsRef.current.set(1, transport)
    bridge.dispose()
  })

  it('connects once with the exact conversation after the initial snapshot applies', async () => {
    const bridge = registerAgentStatusStartupSnapshot()
    const { session, transport, replay } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    expect(transport.connect).not.toHaveBeenCalled()
    replay()
    bridge.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).toHaveBeenCalledOnce()
    expect(transport.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "cursor-agent '--resume' 'conversation-742'",
        resumeProviderSession: { key: 'conversation_id', id: 'conversation-742' },
        initiallyHidden: true
      })
    )
    bridge.dispose()
  })

  it.each(['disposed', 'replaced', 'generation'] as const)(
    'never connects an obsolete %s pane after waiting',
    async (kind) => {
      const bridge = registerAgentStatusStartupSnapshot()
      const { session, fixture, transport } = createSession()
      startDeferredSessionReattach(session, 'lost-pty')
      if (kind === 'disposed') {
        fixture.disposed = true
      }
      if (kind === 'replaced') {
        fixture.deps.paneTransportsRef.current.delete(1)
      }
      if (kind === 'generation') {
        fixture.transportStreamGeneration += 1
      }
      bridge.settle()
      await vi.advanceTimersByTimeAsync(0)
      expect(transport.connect).not.toHaveBeenCalled()
      bridge.dispose()
    }
  )

  it('retains the bounded fallback when the host never answers', async () => {
    const bridge = registerAgentStatusStartupSnapshot()
    const { session, transport } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    await vi.advanceTimersByTimeAsync(4_999)
    expect(transport.connect).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(transport.connect).toHaveBeenCalledOnce()
    bridge.dispose()
  })

  it('ignores an old bridge completion after replacement', async () => {
    const old = registerAgentStatusStartupSnapshot()
    const { session, transport, replay } = createSession()
    startDeferredSessionReattach(session, 'lost-pty')
    const replacement = registerAgentStatusStartupSnapshot()
    old.settle()
    old.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).not.toHaveBeenCalled()
    replay()
    replacement.settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(transport.connect).toHaveBeenCalledOnce()
    replacement.dispose()
  })
})
