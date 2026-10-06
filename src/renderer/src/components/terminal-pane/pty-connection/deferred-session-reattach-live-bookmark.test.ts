import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { runDeferredSessionReattachChoice } from './deferred-session-reattach-choice'
import type * as PairedParkedTerminalRestore from './paired-parked-terminal-restore'

// Reproduction: a mirrored remote web-terminal pane whose host PTY is alive, with a periodic
// origin:'live' crash-recovery bookmark, must attach to that PTY, not cold-restore a fresh agent.

const TAB_ID = 'web-terminal-tab-1'
const LEAF_ID = 'leaf-1'
const ENV_ID = 'env-1'
const REMOTE_PTY_ID = `remote:${ENV_ID}@@term_1`
const WORKTREE_ID = 'repo-1::/workspaces/wt-1'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  return { state, startDeferredSessionReattach: vi.fn(), canRestorePairedParked: false }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state }
}))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('../pty-dispatcher', () => ({ getEagerPtyBufferHandle: () => null }))
vi.mock('./paired-parked-terminal-restore', async (importOriginal) => ({
  ...(await importOriginal<typeof PairedParkedTerminalRestore>()),
  canRestorePairedParkedTerminal: () => mocks.canRestorePairedParked
}))
vi.mock('./deferred-session-reattach-connect', () => ({
  startDeferredSessionReattach: mocks.startDeferredSessionReattach
}))

const now = Date.UTC(2026, 8, 25)

const codexLiveBookmark = {
  worktreeId: WORKTREE_ID,
  tabId: TAB_ID,
  leafId: LEAF_ID,
  agent: 'codex',
  providerSession: { key: 'session_id', id: 'codex-conv-1' },
  connectionId: null,
  state: 'done',
  origin: 'live',
  capturedAt: now,
  updatedAt: now,
  launchConfig: { agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'" }
}

const claudeLiveBookmark = {
  worktreeId: WORKTREE_ID,
  tabId: TAB_ID,
  leafId: LEAF_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'claude-conv-1' },
  connectionId: ENV_ID,
  state: 'working',
  origin: 'live',
  capturedAt: now,
  updatedAt: now
}

function setStore(sleepingRecord: Record<string, unknown> | null, tabId = TAB_ID): void {
  const paneKey = `${tabId}:${LEAF_ID}`
  mocks.state = {
    tabsByWorktree: { [WORKTREE_ID]: [{ id: tabId, ptyId: REMOTE_PTY_ID }] },
    ptyIdsByTabId: { [tabId]: [REMOTE_PTY_ID] },
    sleepingAgentSessionsByPaneKey: sleepingRecord ? { [paneKey]: sleepingRecord } : {},
    runtimeStatusByEnvironmentId: new Map()
  }
}

function buildSession(
  tabId = TAB_ID,
  overrides: Record<string, unknown> = {}
): ConnectPanePtySession {
  const paneKey = `${tabId}:${LEAF_ID}`
  let attachedPtyId: string | null = null
  const transport = {
    attach: vi.fn((opts: { existingPtyId: string }) => {
      attachedPtyId = opts.existingPtyId
    }),
    getPtyId: () => attachedPtyId
  }
  const session = {
    pane: { id: 1, leafId: LEAF_ID },
    cacheKey: paneKey,
    pendingSpawnKey: paneKey,
    tabGeneration: 0,
    transport,
    cols: 80,
    rows: 24,
    disposed: false,
    hadExistingPaneTransportAtConnect: false,
    mountFollowsTerminalPark: false,
    runtimeEnvironmentId: ENV_ID,
    connectionId: null,
    allowInitialIdleCacheSeed: true,
    deps: {
      tabId,
      worktreeId: WORKTREE_ID,
      restoredLeafId: LEAF_ID,
      restoredPtyIdByLeafId: { [LEAF_ID]: REMOTE_PTY_ID },
      paneTransportsRef: { current: new Map([[1, transport]]) },
      clearTabPtyId: vi.fn()
    },
    // Mirrors installSleepingRecordAccess's stable-key lookup, which does not filter on origin.
    getSleepingRecordForPane: (state: {
      sleepingAgentSessionsByPaneKey: Record<string, unknown>
    }) => {
      const record = state.sleepingAgentSessionsByPaneKey[paneKey]
      return record ? { paneKey, record } : null
    },
    buildColdRestoreAgentResumeStartup: vi.fn(() => ({ command: 'resume' })),
    syncPanePtyLayoutBinding: vi.fn(),
    clearPaneMode2031State: vi.fn(),
    clearHiddenOutputRestoreState: vi.fn(),
    captureTransportOutputCallbacks: vi.fn(() => ({ callbacks: {}, generation: 0 })),
    bindActivePanePty: vi.fn(),
    registerPaneSerializerFor: vi.fn(),
    reportError: vi.fn(),
    startFreshSpawn: vi.fn(),
    startFreshColdRestoreAgentResume: vi.fn(),
    armDirectSshPaneRetryTimeout: vi.fn(),
    canAdoptCapturedDirectSshRetryPty: vi.fn(() => true),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bag covers every member runDeferredSessionReattachChoice reads.
  return session as unknown as ConnectPanePtySession
}

function expectAttachedToLiveRemotePty(session: ConnectPanePtySession): void {
  expect(session.transport.attach).toHaveBeenCalledWith(
    expect.objectContaining({ existingPtyId: REMOTE_PTY_ID })
  )
  expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  expect(session.startFreshSpawn).not.toHaveBeenCalled()
  expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
  expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(null)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canRestorePairedParked = false
})

describe('deferred reattach choice: mirrored remote pane with a live crash-recovery bookmark', () => {
  it('attaches to the restored remote PTY when there is no sleeping note', () => {
    setStore(null)
    const session = buildSession()
    runDeferredSessionReattachChoice(session)
    expectAttachedToLiveRemotePty(session)
    expect(mocks.startDeferredSessionReattach).not.toHaveBeenCalled()
  })

  it.each([
    ['a done codex', codexLiveBookmark],
    ['a working claude', claudeLiveBookmark]
  ])('still attaches to the live remote PTY under %s live bookmark', (_label, record) => {
    setStore(record)
    const session = buildSession()
    runDeferredSessionReattachChoice(session)
    expectAttachedToLiveRemotePty(session)
  })

  // Why: the host owns a mirrored tab's liveness, so no client note may divert its start.
  it.each(['worktree-sleep', 'quit'])(
    'still attaches to the host PTY under a genuine %s sleep note',
    (origin) => {
      setStore({ ...codexLiveBookmark, origin })
      const session = buildSession()
      runDeferredSessionReattachChoice(session)
      expectAttachedToLiveRemotePty(session)
      expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
    }
  )

  it('reattaches a parked-tab mount under a live note without clearing the binding', () => {
    mocks.canRestorePairedParked = true
    setStore(codexLiveBookmark)
    const session = buildSession(TAB_ID, { mountFollowsTerminalPark: true })
    runDeferredSessionReattachChoice(session)
    expect(mocks.startDeferredSessionReattach).toHaveBeenCalledWith(session, REMOTE_PTY_ID)
    expect(session.syncPanePtyLayoutBinding).not.toHaveBeenCalledWith(null)
    expect(session.deps.clearTabPtyId).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(session.buildColdRestoreAgentResumeStartup).not.toHaveBeenCalled()
  })
})

describe('deferred reattach choice: client-created runtime tab keeps its sleep note', () => {
  it.each(['worktree-sleep', 'quit'])(
    'takes the slept branch under a real %s sleep note',
    (origin) => {
      const tabId = 'client-tab-1'
      setStore({ ...codexLiveBookmark, tabId, origin }, tabId)
      const session = buildSession(tabId)
      runDeferredSessionReattachChoice(session)
      expect(session.transport.attach).not.toHaveBeenCalled()
      expect(session.syncPanePtyLayoutBinding).toHaveBeenCalledWith(null)
      expect(session.deps.clearTabPtyId).toHaveBeenCalledWith(tabId, REMOTE_PTY_ID)
      expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledWith({ command: 'resume' })
      expect(session.startFreshSpawn).not.toHaveBeenCalled()
    }
  )
})
