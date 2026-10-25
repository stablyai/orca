import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Success must settle after no-ID/expiry rejection; otherwise healed attempts stay pending for 31s or failed attaches falsely reopen recovery budgets. */
const mocks = vi.hoisted(() => ({
  state: { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))

type SettleSpy = ReturnType<typeof vi.fn>

function buildSession(overrides: Record<string, unknown> = {}): {
  session: ConnectPanePtySession
  settlePaneAttachAttempt: SettleSpy
} {
  const settlePaneAttachAttempt = vi.fn()
  const transport = {
    getPtyId: () => 'pty-1',
    disconnect: vi.fn(),
    serializeBuffer: vi.fn()
  }
  const session = {
    settlePaneAttachAttempt,
    transport,
    disposed: false,
    transportStreamGeneration: 0,
    authoritativeReattachGeneration: 0,
    pane: { id: 'pane-1', leafId: 'leaf-1', terminal: {} },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: new Map([['pane-1', transport]]) },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn(),
      updateTabPtyId: vi.fn(),
      restoredLeafId: null
    },
    registerEffectiveLaunchConfig: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    setPanePtyFitBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    ...overrides
  } as unknown as ConnectPanePtySession
  bindHandleReattachResult(session)
  return { session, settlePaneAttachAttempt }
}

/** The pane-transport registry is keyed by pane id; the bag is deliberately untyped. */
function setPaneTransports(session: ConnectPanePtySession, transports: Map<string, unknown>): void {
  ;(session.deps as unknown as { paneTransportsRef: { current: unknown } }).paneTransportsRef = {
    current: transports
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
})

describe('handleReattachResult recovery settle', () => {
  it('reports success once the attach payload is authoritative', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    const afterIdentityCommit = new Error('stop after the authoritative identity commit')
    session.agentCompletionCoordinator = {
      ...session.agentCompletionCoordinator,
      startProcessTracking: vi.fn(() => {
        throw afterIdentityCommit
      })
    }

    await expect(session.handleReattachResult({ id: 'pty-1', isReattach: true })).rejects.toBe(
      afterIdentityCommit
    )

    expect(settlePaneAttachAttempt).toHaveBeenCalledWith('success')
  })

  it('does not report success for a reattach that returned no PTY id', async () => {
    // No-ID fallback cannot settle success before cold restore replaces its recovery ledger.
    const { session, settlePaneAttachAttempt } = buildSession({
      transport: {
        getPtyId: () => null,
        disconnect: vi.fn(),
        serializeBuffer: vi.fn()
      }
    })
    setPaneTransports(session, new Map([['pane-1', session.transport]]))

    await expect(session.handleReattachResult(undefined, null)).resolves.toBe(false)

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith('success')
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
  })

  it('does not report success for an expired session', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    await expect(
      session.handleReattachResult({ id: 'pty-1', sessionExpired: true }, 'pty-old')
    ).resolves.toBe(false)

    expect(session.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith('pty-old')
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith('success')
  })

  it('does not report success for a superseded transport', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()
    setPaneTransports(session, new Map())

    await expect(session.handleReattachResult({ id: 'pty-1', isReattach: true })).resolves.toBe(
      false
    )

    expect(session.authoritativeReattachGeneration).toBe(0)

    expect(settlePaneAttachAttempt).not.toHaveBeenCalled()
  })
})
