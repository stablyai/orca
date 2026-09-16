import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * `handleReattachResult` holds the only `success` settle in the recovery state
 * machine. Without it every attempt stays `pending` until the 31s settlement
 * bound ages out, so the entire "observed success" half of the gate — the thing
 * that distinguishes this design from the counting budget it replaces — can be
 * deleted with no other test noticing.
 *
 * Placement is load-bearing too. Settling at the `authoritativeReattachGeneration`
 * bump instead would mark the storm's OWN failure path (`reattach returned no
 * PTY id` → recoverUnverifiableDirectSshReattach) as a success and reopen the
 * loop, so the negative case below is as important as the positive one.
 */
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
    connectionId: null,
    directSshRetryAttempt: undefined,
    capturedDirectSshRetryPtyAccepted: false,
    rejectObsoleteDirectSshReattach: () => false,
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

/**
 * Only the settle is under assertion here; everything downstream of it has its
 * own tests and needs a far larger session bag than this. A throw BEFORE the
 * settle still fails the test, which is the regression this pins.
 */
async function driveReattach(
  session: ConnectPanePtySession,
  result: unknown,
  staleSessionId?: string | null
): Promise<void> {
  try {
    await session.handleReattachResult(result, staleSessionId)
  } catch {
    // See above.
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
})

describe('handleReattachResult recovery settle', () => {
  it('reports success once the attach payload is authoritative', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    await driveReattach(session, { id: 'pty-1', isReattach: true })

    expect(settlePaneAttachAttempt).toHaveBeenCalledWith(undefined, 'success')
  })

  it('does not report success for a reattach that returned no PTY id', async () => {
    // The storm's own path. Settling this as success would clear the ledger the
    // failure is about to be written to, and the chain would restart.
    const { session, settlePaneAttachAttempt } = buildSession({
      connectionId: 'ssh-1',
      transport: {
        getPtyId: () => null,
        disconnect: vi.fn(),
        serializeBuffer: vi.fn()
      }
    })
    setPaneTransports(session, new Map([['pane-1', session.transport]]))

    await driveReattach(session, undefined, null)

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith(undefined, 'success')
    expect(settlePaneAttachAttempt).toHaveBeenCalledWith(undefined, 'failed')
  })

  it('does not report success for an expired session', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()

    await driveReattach(session, { id: 'pty-1', sessionExpired: true }, 'pty-old')

    expect(settlePaneAttachAttempt).not.toHaveBeenCalledWith(undefined, 'success')
  })

  it('does not report success for a superseded transport', async () => {
    const { session, settlePaneAttachAttempt } = buildSession()
    setPaneTransports(session, new Map())

    await driveReattach(session, { id: 'pty-1', isReattach: true })

    expect(settlePaneAttachAttempt).not.toHaveBeenCalled()
  })
})
