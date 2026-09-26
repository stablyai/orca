import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import { bindSerializeHiddenOutputSnapshot } from './hidden-output-snapshot-serialize'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { HiddenOutputSnapshotResult } from './hidden-output-snapshot-serialize'
import type { ReattachPayloadContext } from './reattach-payload-context'
import { TerminalKittyKeyboardModeTracker } from '../../../../../shared/terminal-kitty-keyboard-mode-tracker'

/**
 * A park-reveal of a remote-runtime pty arrives with `replay: ''`, so the host
 * snapshot probe is the ONLY structural paint. The probe has three answers and
 * the handler must keep them apart (docs/reference/ssh-execution-boundary.md):
 *
 *   host image            → paint it (the structural clear + repaint)
 *   unverifiable          → paint nothing AND re-ask the host, bounded
 *   no host image         → paint nothing, ask nothing
 *
 * These tests assert on the decision the handler hands to the payload and the
 * retry it arms, not on what the pane looks like: a live host also pushes a
 * retained tail at subscribe time, so the rendered pane can look right whether
 * or not the decision was.
 */
const REMOTE_PTY_ID = 'remote:env-1@@pty-1'
const HOST_IMAGE = { data: 'PROMPT $ ', cols: 80, rows: 24, seq: 7, source: 'headless' as const }

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
  const capturedContexts: ReattachPayloadContext[] = []
  const callOrder: string[] = []
  return { state, capturedContexts, callOrder }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../terminal-freeze-breadcrumbs', () => ({ recordTerminalFreezeBreadcrumb: vi.fn() }))
// Why: the payload handlers need a mounted xterm; what matters here is the
// context the handler decided on, so capture it and report the payload applied.
vi.mock('./apply-reattach-payload', () => ({
  createReattachPayloadHandlers: (_session: unknown, ctx: ReattachPayloadContext) => {
    mocks.capturedContexts.push(ctx)
    return {
      applyReattachPayload: async () => {
        mocks.callOrder.push('applyReattachPayload')
        ctx.reattachPayloadApplied = true
      },
      fitAfterReattachRestore: async () => {
        mocks.callOrder.push('fitAfterReattachRestore')
      }
    }
  }
}))

type Bag = {
  session: ConnectPanePtySession
  transport: Record<string, unknown>
  /** The pane-transport registry, keyed by pane id; the bag is deliberately untyped. */
  paneTransports: Map<string, unknown>
  retryUnverifiableParkRevealSnapshot: ReturnType<typeof vi.fn>
  warnParkRevealNoHostImage: ReturnType<typeof vi.fn>
  structuralRun: ReturnType<typeof vi.fn>
}

function buildParkRevealSession(overrides: Record<string, unknown> = {}): Bag {
  const transport: Record<string, unknown> = {
    getPtyId: () => REMOTE_PTY_ID,
    disconnect: vi.fn(),
    serializeBuffer: vi.fn()
  }
  const paneTransports = new Map<string, unknown>([['pane-1', transport]])
  const warnParkRevealNoHostImage = vi.fn(() => {
    mocks.callOrder.push('warnParkRevealNoHostImage')
    return true
  })
  const retryUnverifiableParkRevealSnapshot = vi.fn(() => {
    mocks.callOrder.push('retryUnverifiableParkRevealSnapshot')
    return true
  })
  const structuralRun = vi.fn(
    async (
      task: () => Promise<void>,
      opts?: { afterRestore?: () => Promise<void> }
    ): Promise<void> => {
      await task()
      await opts?.afterRestore?.()
    }
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a deliberately partial session bag; only the members the park-reveal decision touches exist, so an unexpected access fails the test.
  const session = {
    transport,
    disposed: false,
    transportStreamGeneration: 0,
    authoritativeReattachGeneration: 0,
    // The reveal remount of a parked pane; consume-once in the handler.
    mountFollowsTerminalPark: true,
    followsDirectSshReconnect: false,
    connectionId: null,
    cacheKey: 'cache-1',
    directSshRetryAttempt: undefined,
    capturedDirectSshRetryPtyAccepted: false,
    pane: { id: 'pane-1', leafId: 'leaf-1', terminal: { options: { scrollback: 1000 } } },
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      paneTransportsRef: { current: paneTransports },
      isVisibleRef: { current: true },
      clearTabPtyId: vi.fn(),
      updateTabPtyId: vi.fn(),
      restoredLeafId: null
    },
    agentCompletionCoordinator: { startProcessTracking: vi.fn() },
    structuralReplayCoordinator: { run: structuralRun },
    getSshMainModelSnapshotProbe: () => async () => null,
    serializeHiddenOutputSnapshot: vi.fn(),
    retryUnverifiableParkRevealSnapshot,
    warnParkRevealNoHostImage,
    rejectObsoleteDirectSshReattach: () => false,
    registerEffectiveLaunchConfig: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    setPanePtyFitBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    sampleVisiblePaneForegroundAgent: vi.fn(),
    scheduleReattachIdleAgentCursorReset: vi.fn(),
    settlePaneAttachAttempt: vi.fn(),
    kittyKeyboardModes: new TerminalKittyKeyboardModeTracker(),
    kittyShortcutInputSettlement: { settle: vi.fn() },
    ...overrides
  } as unknown as ConnectPanePtySession
  bindHandleReattachResult(session)
  return {
    session,
    transport,
    paneTransports,
    retryUnverifiableParkRevealSnapshot,
    warnParkRevealNoHostImage,
    structuralRun
  }
}

/** The remote transport's park-reveal result: a bare reattach with no relay tail. */
const PARK_REVEAL_RESULT = { id: REMOTE_PTY_ID, replay: '', isReattach: true }

function probeAnswers(result: HiddenOutputSnapshotResult): ReturnType<typeof vi.fn> {
  return vi.fn(async () => result)
}

function decidedContext(): ReattachPayloadContext {
  expect(mocks.capturedContexts).toHaveLength(1)
  return mocks.capturedContexts[0]!
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state = { tabsByWorktree: {}, terminalLayoutsByTabId: {} }
  mocks.capturedContexts = []
  mocks.callOrder = []
})

describe('handleReattachResult park-reveal snapshot verdict', () => {
  it('paints a host image and arms no retry', async () => {
    const bag = buildParkRevealSession({
      serializeHiddenOutputSnapshot: probeAnswers({ kind: 'snapshot', snapshot: HOST_IMAGE })
    })

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

    const ctx = decidedContext()
    expect(ctx.prefetchedParkModelSnapshot).toBe(HOST_IMAGE)
    expect(ctx.shouldApplyStructuralPayload).toBe(true)
    expect(bag.structuralRun).toHaveBeenCalledOnce()
    expect(bag.retryUnverifiableParkRevealSnapshot).not.toHaveBeenCalled()
  })

  // The defect: a host that stayed silent past the request timeout used to
  // collapse to the same null as "nothing to paint" and was never asked again.
  it('does not paint blank when the host stayed silent, and re-asks it', async () => {
    const bag = buildParkRevealSession({
      serializeHiddenOutputSnapshot: probeAnswers({ kind: 'retry-worthy', source: 'host' })
    })

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

    const ctx = decidedContext()
    expect(ctx.prefetchedParkModelSnapshot).toBeNull()
    // No structural transaction means no `\x1b[2J\x1b[3J` clear over the client's own copy.
    expect(ctx.shouldApplyStructuralPayload).toBe(false)
    expect(bag.structuralRun).not.toHaveBeenCalled()
    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledExactlyOnceWith(
      REMOTE_PTY_ID,
      'host'
    )
    // The retry's own repaint must queue behind this attempt, never nest inside it.
    expect(mocks.callOrder).toEqual([
      'applyReattachPayload',
      'fitAfterReattachRestore',
      'retryUnverifiableParkRevealSnapshot'
    ])
  })

  it('treats a rejected probe on a modern remote transport as the host staying silent', async () => {
    const bag = buildParkRevealSession({
      hiddenOutputRestoreLegacyPtyId: null,
      serializeHiddenOutputSnapshot: vi.fn(async () => {
        throw new Error('Remote terminal snapshot timed out.')
      })
    })
    bag.transport.serializeBufferOutcome = vi.fn()

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

    expect(decidedContext().prefetchedParkModelSnapshot).toBeNull()
    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledExactlyOnceWith(
      REMOTE_PTY_ID,
      'host'
    )
  })

  // Through the real serializer: the host answered `unavailable: 'no-serializable-buffer'`,
  // whose own host-side comment reads "not proof the pane is empty".
  it("re-asks a host that answered 'no-serializable-buffer' instead of painting blank", async () => {
    const bag = buildParkRevealSession({
      canUseMainBufferSnapshot: () => false,
      hiddenOutputRestoreLegacyPtyId: null
    })
    bag.transport.serializeBufferOutcome = vi.fn(async () => ({
      availability: { kind: 'retry-worthy', cause: 'host-no-serializable-buffer' },
      snapshot: null
    }))
    bindSerializeHiddenOutputSnapshot(bag.session)

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

    expect(bag.transport.serializeBufferOutcome).toHaveBeenCalledOnce()
    const ctx = decidedContext()
    expect(ctx.prefetchedParkModelSnapshot).toBeNull()
    expect(ctx.shouldApplyStructuralPayload).toBe(false)
    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledExactlyOnceWith(
      REMOTE_PTY_ID,
      'host'
    )
  })

  it('does not paint an imageless success over the client copy, and re-asks', async () => {
    const bag = buildParkRevealSession({
      serializeHiddenOutputSnapshot: probeAnswers({
        kind: 'snapshot',
        snapshot: { ...HOST_IMAGE, data: '' }
      })
    })

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

    expect(decidedContext().prefetchedParkModelSnapshot).toBeNull()
    expect(bag.structuralRun).not.toHaveBeenCalled()
    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledExactlyOnceWith(
      REMOTE_PTY_ID,
      'host'
    )
  })

  it('charges a local request-lane gate to the local budget', async () => {
    const bag = buildParkRevealSession({
      serializeHiddenOutputSnapshot: probeAnswers({ kind: 'retry-worthy', source: 'local' })
    })

    await bag.session.handleReattachResult(PARK_REVEAL_RESULT)

    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledExactlyOnceWith(
      REMOTE_PTY_ID,
      'local'
    )
  })

  // Unavoidable loss, made visible: the host answered and cannot produce the buffer, so the
  // pane must say so rather than pass for an empty terminal — and never ask again.
  it.each(['permanently-unavailable', 'unavailable'] as const)(
    'paints nothing, asks nothing, and banners the loss when the host answered %s',
    async (kind) => {
      const bag = buildParkRevealSession({ serializeHiddenOutputSnapshot: probeAnswers({ kind }) })

      await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(true)

      const ctx = decidedContext()
      expect(ctx.prefetchedParkModelSnapshot).toBeNull()
      expect(ctx.shouldApplyStructuralPayload).toBe(false)
      expect(bag.retryUnverifiableParkRevealSnapshot).not.toHaveBeenCalled()
      expect(bag.warnParkRevealNoHostImage).toHaveBeenCalledExactlyOnceWith(REMOTE_PTY_ID, kind)
      expect(mocks.callOrder).toEqual([
        'applyReattachPayload',
        'fitAfterReattachRestore',
        'warnParkRevealNoHostImage'
      ])
    }
  )

  it.each([
    ['a host image', { kind: 'snapshot', snapshot: HOST_IMAGE }],
    ['an unverifiable answer', { kind: 'retry-worthy', source: 'host' }]
  ] as const)('does not banner the loss on %s', async (_label, result) => {
    const bag = buildParkRevealSession({ serializeHiddenOutputSnapshot: probeAnswers(result) })

    await bag.session.handleReattachResult(PARK_REVEAL_RESULT)

    expect(bag.warnParkRevealNoHostImage).not.toHaveBeenCalled()
  })

  it('arms no retry for an attempt a remount superseded while the probe was in flight', async () => {
    const bag = buildParkRevealSession()
    bag.session.serializeHiddenOutputSnapshot = vi.fn(async () => {
      // A successor mount registered its own transport before the probe settled.
      bag.paneTransports.set('pane-1', { getPtyId: () => REMOTE_PTY_ID })
      return { kind: 'retry-worthy', source: 'host' }
    })

    await expect(bag.session.handleReattachResult(PARK_REVEAL_RESULT)).resolves.toBe(false)

    expect(mocks.capturedContexts).toHaveLength(0)
    expect(bag.retryUnverifiableParkRevealSnapshot).not.toHaveBeenCalled()
  })

  it('probes only the first reattach of a reveal remount', async () => {
    const probe = probeAnswers({ kind: 'retry-worthy', source: 'host' })
    const bag = buildParkRevealSession({ serializeHiddenOutputSnapshot: probe })

    await bag.session.handleReattachResult(PARK_REVEAL_RESULT)
    await bag.session.handleReattachResult(PARK_REVEAL_RESULT)

    expect(probe).toHaveBeenCalledOnce()
    expect(bag.retryUnverifiableParkRevealSnapshot).toHaveBeenCalledOnce()
  })
})
