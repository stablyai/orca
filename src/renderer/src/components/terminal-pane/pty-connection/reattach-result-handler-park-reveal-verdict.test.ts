import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindHandleReattachResult } from './reattach-result-handler'
import { bindSerializeHiddenOutputSnapshot } from './hidden-output-snapshot-serialize'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { HiddenOutputSnapshotResult } from './hidden-output-snapshot-serialize'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'

/** Probe decisions must distinguish image, bounded unverifiable retry and permanent unavailability; subscribe-time tail paint could hide a wrong decision in visual assertions (docs/reference/ssh-execution-boundary.md). */
const REMOTE_PTY_ID = 'remote:env-1@@pty-1'
const HOST_IMAGE = { data: 'PROMPT $ ', cols: 80, rows: 24, seq: 7, source: 'headless' as const }

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    agentLaunchConfigByPaneKey: {},
    agentStatusByPaneKey: {}
  }
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
// Main's resume banner has its own tests (main-pane-resume-banner.test.ts).
vi.mock('./main-pane-resume-banner', () => ({ showMainPaneResumeOutcome: vi.fn() }))
// Capture payload context without mounting xterm; these cases assert the handler’s decision.
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
    cacheKey: 'cache-1',
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
    serializeHiddenOutputSnapshot: vi.fn(),
    retryUnverifiableParkRevealSnapshot,
    warnParkRevealNoHostImage,
    registerEffectiveLaunchConfig: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    // Layout-owner build: the empty-reattach evidence reads the pane's record through this.
    buildColdRestoreAgentResumeStartup: vi.fn(() => null),
    setPanePtyFitBinding: vi.fn(),
    reportPanePtyVisibility: vi.fn(),
    registerSideEffectFactConsumerForPty: vi.fn(),
    syncHiddenRendererPtyDelivery: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    sampleVisiblePaneForegroundAgent: vi.fn(),
    scheduleReattachIdleAgentCursorReset: vi.fn(),
    settlePaneAttachAttempt: vi.fn(),
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
  mocks.state = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    agentLaunchConfigByPaneKey: {},
    agentStatusByPaneKey: {}
  }
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

  // Timeout must retain bounded retry rather than collapse into a final nothing-to-paint result.
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

  // Exercise real serializer classification of no-serializable-buffer, which does not prove emptiness.
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

  // Permanent no-image verdict must disclose loss and stop retrying, rather than look like an empty terminal.
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

// Only local empty-reattach retirement converges; remote disconnect merely closes this view and would reattach the same live PTY forever.
describe('handleReattachResult empty reattach under a hibernation note', () => {
  const record = {
    paneKey: 'tab-1:leaf-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'conv-1' },
    prompt: '',
    state: 'done',
    origin: 'worktree-sleep',
    capturedAt: 1,
    updatedAt: 1
  } as const
  const startup: ColdRestoreAgentResumeStartup = {
    command: 'codex resume conv-1',
    agent: 'codex',
    resumeOrigin: 'saved',
    resumeProviderSession: record.providerSession,
    launchConfig: { agentArgs: '', agentEnv: {} },
    launchToken: 'token-1',
    useLiveEntry: false,
    hasSleepingRecord: true,
    sleepingRecordEntry: { paneKey: record.paneKey, record }
  }

  // The wake-hint row passes a non-remote stale id: only the result's remote id may decide.
  it.each([
    ['a fresh-spawn adoption', false, null],
    ['a paired-parked reveal', true, REMOTE_PTY_ID],
    ['a host wake-hint reattach', false, 'term_1']
  ])('keeps the live remote PTY on %s', async (_label, mountFollowsTerminalPark, staleId) => {
    const bag = buildParkRevealSession({
      mountFollowsTerminalPark,
      serializeHiddenOutputSnapshot: probeAnswers({ kind: 'snapshot', snapshot: HOST_IMAGE })
    })

    await expect(
      bag.session.handleReattachResult(PARK_REVEAL_RESULT, staleId, startup)
    ).resolves.toBe(true)

    expect(bag.transport.disconnect).not.toHaveBeenCalled()
    expect(bag.session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(bag.session.setPanePtyFitBinding).toHaveBeenCalledWith(REMOTE_PTY_ID)
  })

  it.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
    'keeps the shell main kept after its start, without asking main again',
    async () => {
      const bag = buildParkRevealSession({
        mountFollowsTerminalPark: false,
        buildColdRestoreAgentResumeStartup: vi.fn(() => startup),
        mainStartAttach: {}
      })

      await expect(
        bag.session.handleReattachResult({ id: 'local-pty-1', isReattach: true }, null, null)
      ).resolves.toBe(true)

      expect(bag.transport.disconnect).not.toHaveBeenCalled()
      expect(bag.session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
      expect(bag.session.setPanePtyFitBinding).toHaveBeenCalledWith('local-pty-1')
    }
  )

  it('retires an empty local fresh-spawn adoption and resumes the provider session', async () => {
    const bag = buildParkRevealSession({
      mountFollowsTerminalPark: false,
      // Layout-owner build: main's attach carries no resume, so the evidence reads the record.
      buildColdRestoreAgentResumeStartup: vi.fn(() => startup)
    })

    await expect(
      bag.session.handleReattachResult(
        { id: 'local-pty-1', isReattach: true },
        null,
        ORCA_LAYOUT_OWNER_IS_MAIN ? null : startup
      )
    ).resolves.toBe(false)

    expect(bag.transport.disconnect).toHaveBeenCalledOnce()
    expect(bag.session.setPanePtyFitBinding).not.toHaveBeenCalled()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main retires the shell and resumes the agent in its place; the window unbinds nothing.
      expect(bag.session.syncPanePtyLayoutBinding).not.toHaveBeenCalled()
      expect(bag.session.startFreshColdRestoreAgentResume).toHaveBeenCalledExactlyOnceWith(null)
      return
    }
    expect(bag.session.syncPanePtyLayoutBinding).toHaveBeenCalledWith(null)
    expect(bag.session.startFreshColdRestoreAgentResume).toHaveBeenCalledExactlyOnceWith(startup, {
      forceBlankRestoredViewport: true
    })
  })
})
