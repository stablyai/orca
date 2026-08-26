import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPane } from '../pty-connection-test-pane-fixtures'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '../pty-connection-test-environment'
import { createReattachPayloadHandlers } from './apply-reattach-payload'
import type { PtyBufferSnapshot } from '../pty-transport'
import type { ReattachPayloadContext } from './reattach-payload-context'
import type { ReattachPayloadSession } from './reattach-payload-session'

const ALT_ON = '\x1b[?1049h'
const ALT_OFF = '\x1b[?1049l'
const MODEL_MARKER = 'MODEL-FULL-SCREEN-FRAME'
const PARK_MARKER = 'PARK-PREFETCHED-FRAME'
// Shaped like the real fragment: a ~100KiB relay tail begins mid-escape, so its
// head prints as literal text instead of rebuilding the frame it no longer holds.
const RELAY_TAIL = '30;1Hupd-0003312'

/** One log for every ordering-relevant call, so fire order is asserted on real sequence. */
type FireLog = string[]

function createModelSnapshot(overrides: Partial<PtyBufferSnapshot> = {}): PtyBufferSnapshot {
  return {
    source: 'headless',
    alternateScreen: true,
    data: MODEL_MARKER,
    cols: 120,
    rows: 40,
    seq: 42,
    ...overrides
  }
}

function createSession(
  fireLog: FireLog,
  overrides: Record<string, unknown> = {}
): ReattachPayloadSession {
  return {
    pane: createPane(1),
    rememberReattachPayloadAgentSignal: vi.fn(),
    writeReplayData: vi.fn((data: string) => fireLog.push(`write:${data}`)),
    reattachReplayResetSequence: vi.fn(() => '<reset>'),
    sendFocusedReattachFocusInAfterReplay: vi.fn(),
    applySnapshotKittyKeyboardModes: vi.fn(() => fireLog.push('kitty:snapshot-baseline')),
    setRestoredSnapshotBaseline: vi.fn(),
    recordRendererOrderedSeq: vi.fn(),
    isPaneOnAlternateScreen: vi.fn(() => false),
    shouldPreserveAgentReattachModes: vi.fn(() => false),
    kittyKeyboardModes: {
      hasProvenBaseline: true,
      isAlternateScreen: false,
      reset: vi.fn(),
      resetForSnapshot: vi.fn(() => fireLog.push('kitty:reset-for-snapshot')),
      scanReplay: vi.fn(() => fireLog.push('kitty:scan-replay'))
    },
    ...overrides
  } as unknown as ReattachPayloadSession
}

function createContext(overrides: Partial<ReattachPayloadContext>): ReattachPayloadContext {
  return {
    isCurrentReattachPayload: () => true,
    connectResult: { id: 'pty-1', replay: RELAY_TAIL },
    ptyId: 'ssh:conn-1:pty-1',
    attemptGeneration: 1,
    prefetchedParkModelSnapshot: null,
    revealFollowsTerminalPark: false,
    reconnectMayUseModel: false,
    fetchSshMainModelReattachSnapshot: async () => null,
    shouldApplyStructuralPayload: true,
    coldRestoreStartup: undefined,
    reattachPayloadApplied: false,
    ...overrides
  }
}

function paintedBytes(fireLog: FireLog): string {
  return fireLog
    .filter((entry) => entry.startsWith('write:'))
    .map((entry) => entry.slice('write:'.length))
    .join('')
}

// Regression guard for STA-5395: #15166 unhooked this gate while the pure-function
// test over sshReconnectPaintsFromModel stayed green, so the coverage has to run
// through createReattachPayloadHandlers rather than the gate itself.
describe('reattach payload SSH reconnect model paint', () => {
  beforeEach(() => installTerminalTestGlobals())

  afterEach(async () => restoreTerminalTestGlobals())

  it('paints a non-park SSH reconnect from main model and layers the replay over the kitty baseline', async () => {
    const fireLog: FireLog = []
    const session = createSession(fireLog)
    const probe = vi.fn(async () => createModelSnapshot())
    const ctx = createContext({
      reconnectMayUseModel: true,
      fetchSshMainModelReattachSnapshot: probe
    })

    await createReattachPayloadHandlers(session, ctx).applyReattachPayload()

    // Soft so an unhooked gate reports every invariant it broke, not just the probe.
    expect.soft(probe).toHaveBeenCalledTimes(1)
    const painted = paintedBytes(fireLog)
    expect.soft(painted).toContain(MODEL_MARKER)
    // The tail is exactly what the model replaces; painting both would duplicate output.
    expect.soft(painted).not.toContain(RELAY_TAIL)
    // Kitty pushes made during the outage exist only in the replay, so the replay
    // scan layers ON TOP of the snapshot baseline — inverted, the baseline wins.
    expect.soft(session.kittyKeyboardModes.scanReplay).toHaveBeenCalledWith(RELAY_TAIL)
    expect.soft(session.pane.fitAddon.proposeDimensions).toHaveBeenCalledTimes(2)
    expect.soft(fireLog).toContain('kitty:snapshot-baseline')
    expect
      .soft(fireLog.indexOf('kitty:scan-replay'))
      .toBeGreaterThan(fireLog.indexOf('kitty:snapshot-baseline'))
  })

  it('paints the model when a reconnect has no relay tail', async () => {
    const fireLog: FireLog = []
    const session = createSession(fireLog)
    const probe = vi.fn(async () => createModelSnapshot())
    const ctx = createContext({
      connectResult: { id: 'pty-1', isReattach: true, replay: '' },
      reconnectMayUseModel: true,
      fetchSshMainModelReattachSnapshot: probe
    })

    await createReattachPayloadHandlers(session, ctx).applyReattachPayload()

    expect(probe).toHaveBeenCalledTimes(1)
    expect(paintedBytes(fireLog)).toContain(MODEL_MARKER)
    expect(session.pane.fitAddon.proposeDimensions).toHaveBeenCalledTimes(2)
    expect(ctx.reattachPayloadApplied).toBe(true)
  })

  it('never spends the probe timeout when the replay shows the app left the alternate screen', async () => {
    const fireLog: FireLog = []
    const session = createSession(fireLog)
    const probe = vi.fn(async () => createModelSnapshot())
    const exitedReplay = `${ALT_ON}stale frame${ALT_OFF}$ echo done\r\ndone\r\n$ `
    const ctx = createContext({
      connectResult: { id: 'pty-1', replay: exitedReplay },
      reconnectMayUseModel: true,
      fetchSshMainModelReattachSnapshot: probe
    })

    await createReattachPayloadHandlers(session, ctx).applyReattachPayload()

    // The veto is decided before the fetch: probing first would burn
    // SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS inside the coordinator only to discard it.
    expect(probe).not.toHaveBeenCalled()
    expect(session.pane.fitAddon.proposeDimensions).not.toHaveBeenCalled()
    const painted = paintedBytes(fireLog)
    expect(painted).toContain(exitedReplay)
    expect(painted).not.toContain(MODEL_MARKER)
  })

  it('keeps park precedence over the reconnect snapshot', async () => {
    const fireLog: FireLog = []
    const session = createSession(fireLog)
    const probe = vi.fn(async () => createModelSnapshot())
    // Both flags set deliberately: the handler must resolve the precedence itself
    // rather than relying on the caller keeping park and reconnect disjoint.
    const ctx = createContext({
      revealFollowsTerminalPark: true,
      reconnectMayUseModel: true,
      prefetchedParkModelSnapshot: createModelSnapshot({ data: PARK_MARKER }),
      fetchSshMainModelReattachSnapshot: probe
    })

    await createReattachPayloadHandlers(session, ctx).applyReattachPayload()

    expect(probe).not.toHaveBeenCalled()
    // Park painting measures for its own width checks, but must not pay a third reconnect check.
    expect(session.pane.fitAddon.proposeDimensions).toHaveBeenCalledTimes(2)
    const painted = paintedBytes(fireLog)
    expect(painted).toContain(PARK_MARKER)
    expect(painted).not.toContain(MODEL_MARKER)
  })
})
