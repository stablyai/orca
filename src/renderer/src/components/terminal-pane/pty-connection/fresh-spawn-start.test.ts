import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bindStartFreshSpawn } from './fresh-spawn-start'
import { observeSpawnSettlement } from './unbound-pane-spawn-recovery'
import { pendingSpawnByPaneKey, pendingSpawnGenerationByPaneKey } from './pty-connect-limits'

vi.mock('./unbound-pane-spawn-recovery', () => ({ observeSpawnSettlement: vi.fn() }))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  writeTerminalOutput: vi.fn()
}))
vi.mock('../pty-buffer-serializer', () => ({ hasPtySerializer: vi.fn(() => false) }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ deleteStateByWorktreeId: {}, getTab: () => null }) }
}))

function buildSession(overrides: Record<string, unknown> = {}): never {
  return {
    deps: { tabId: 'tab-1', worktreeId: 'wt-1', cwd: '/w', isVisibleRef: { current: true } },
    pane: { id: 1, leafId: 'leaf-1', terminal: {} },
    // Non-null keeps the spawn off the serializer pre-signal, which is not under test.
    runtimeEnvironmentId: 'rt-1',
    transportOptions: {},
    disposed: false,
    pendingSpawnKey: 'pane-key',
    tabGeneration: 0,
    cols: 80,
    rows: 24,
    authoritativeReattachGeneration: 0,
    transportStreamGeneration: 0,
    kittyKeyboardModes: { reset: vi.fn() },
    isLegacyWorkerAutomaticResumeBlocked: () => false,
    clearPaneMode2031State: vi.fn(),
    clearHiddenOutputRestoreState: vi.fn(),
    resetFreshSpawnFollowOutput: vi.fn(),
    prepareFreshShellViewportForSpawn: vi.fn(),
    shouldDeclareHiddenAtSpawn: () => false,
    captureTransportOutputCallbacks: () => ({ generation: 0, callbacks: {} }),
    armDirectSshPaneRetryTimeout: vi.fn(),
    reportError: vi.fn(),
    finishReattachLiveDataDeferral: vi.fn(),
    transport: { connect: vi.fn(() => new Promise(() => {})), getPtyId: () => null },
    ...overrides
  } as never
}

function resumesProviderSessionForSpawn(session: never): boolean {
  bindStartFreshSpawn(session)
  void (session as unknown as { startFreshSpawn: () => void }).startFreshSpawn()
  return vi.mocked(observeSpawnSettlement).mock.calls[0]?.[2]?.resumesProviderSession === true
}

describe('bindStartFreshSpawn resume classification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pendingSpawnByPaneKey.clear()
    pendingSpawnGenerationByPaneKey.clear()
  })

  // The sidebar "resume a sleeping agent" flow clears its sleeping record at tab
  // creation, so the pane mounts into a PLAIN startFreshSpawn() with no
  // cold-restore override — while spawnIpcPty still replays the provider session
  // off the transport options. Classifying that as non-resume lets a hung spawn
  // be remounted into a SECOND --resume on one transcript.
  it('treats a startup-carried provider session as a resume spawn', () => {
    const session = buildSession({
      transportOptions: { resumeProviderSession: { key: 'session_id', id: 'sess-1' } }
    })

    expect(resumesProviderSessionForSpawn(session)).toBe(true)
  })

  // An AI-vault resume for an agent Orca has no provider-session model for emits
  // `<agent> --resume <id>` as the command and carries NO resumeProviderSession, so
  // only the producer's flag distinguishes it from a first launch.
  it('treats a producer-flagged resume with no provider session as a resume spawn', () => {
    const session = buildSession({
      paneStartup: { command: 'hermes --resume abc123', resumesAgentSession: true }
    })

    expect(resumesProviderSessionForSpawn(session)).toBe(true)
  })

  it('treats a plain spawn as a non-resume spawn', () => {
    expect(resumesProviderSessionForSpawn(buildSession())).toBe(false)
  })

  it('treats an explicit cold-restore override as a resume spawn', () => {
    const session = buildSession()
    bindStartFreshSpawn(session)
    void (session as unknown as { startFreshSpawn: (startup: unknown) => void }).startFreshSpawn({
      launchConfig: { agent: 'claude' }
    })

    expect(vi.mocked(observeSpawnSettlement).mock.calls[0]?.[2]?.resumesProviderSession).toBe(true)
  })
})
