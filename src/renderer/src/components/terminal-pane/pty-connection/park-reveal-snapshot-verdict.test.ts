import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindParkRevealSnapshotVerdictActions,
  classifyParkRevealSnapshot
} from './park-reveal-snapshot-verdict'
import { PARK_REVEAL_NO_HOST_IMAGE_WARNING } from './hidden-output-restore-limits'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const writeTerminalOutput = vi.hoisted(() => vi.fn())

vi.mock('../terminal-freeze-breadcrumbs', () => ({ recordTerminalFreezeBreadcrumb: vi.fn() }))
vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({ writeTerminalOutput }))

const IMAGE = { data: 'PROMPT $ ', cols: 80, rows: 24, seq: 7, source: 'headless' as const }
const REMOTE_PTY_ID = 'remote:env-1@@pty-1'
const LOCAL_PTY_ID = 'wt-1@@local-pty-1'

describe('classifyParkRevealSnapshot', () => {
  it('reads a non-empty host image as positive evidence', () => {
    expect(
      classifyParkRevealSnapshot({ kind: 'snapshot', snapshot: IMAGE }, REMOTE_PTY_ID)
    ).toEqual({
      kind: 'host-snapshot',
      snapshot: IMAGE
    })
  })

  it('reads an alt-screen image as positive evidence even when its data is empty', () => {
    const snapshot = { ...IMAGE, data: '', alternateScreen: true }
    expect(classifyParkRevealSnapshot({ kind: 'snapshot', snapshot }, REMOTE_PTY_ID)).toEqual({
      kind: 'host-snapshot',
      snapshot
    })
  })

  // A remote host's fallback serializer answers `data: ''` with no `unavailable` reason before
  // its pane has hydrated. applyMainBufferSnapshot already refuses to paint that; so must the reveal.
  it('reads a remote imageless success as unverifiable, charged to the host budget', () => {
    expect(
      classifyParkRevealSnapshot(
        { kind: 'snapshot', snapshot: { ...IMAGE, data: '' } },
        REMOTE_PTY_ID
      )
    ).toEqual({ kind: 'unverifiable', ledger: 'host' })
  })

  it('reads an empty local-main model as positive evidence: local main is the execution host', () => {
    const snapshot = { ...IMAGE, data: '' }
    expect(classifyParkRevealSnapshot({ kind: 'snapshot', snapshot }, LOCAL_PTY_ID)).toEqual({
      kind: 'host-snapshot',
      snapshot
    })
  })

  it.each([
    ['host silent past the request timeout', 'host'],
    ['request lane gated before any frame left the client', 'local']
  ] as const)('reads retry-worthy (%s) as unverifiable on the %s ledger', (_label, source) => {
    expect(classifyParkRevealSnapshot({ kind: 'retry-worthy', source }, REMOTE_PTY_ID)).toEqual({
      kind: 'unverifiable',
      ledger: source
    })
  })

  it('reads a legacy host empty reply as unverifiable with no ledger charge', () => {
    expect(classifyParkRevealSnapshot({ kind: 'unknown-legacy-host' }, REMOTE_PTY_ID)).toEqual({
      kind: 'unverifiable',
      ledger: null
    })
  })

  // Retention is never inferred from image content: this arm is reachable only from an
  // explicit host answer, and it carries which one so a caller need not re-derive it.
  it.each(['permanently-unavailable', 'unavailable'] as const)(
    'reads %s as no host image, carrying the answer that closed the door',
    (kind) => {
      expect(classifyParkRevealSnapshot({ kind }, REMOTE_PTY_ID)).toEqual({
        kind: 'no-host-image',
        reason: kind
      })
    }
  )
})

function buildSession(overrides: Record<string, unknown> = {}): ConnectPanePtySession {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a deliberately partial session bag; only the members the verdict actions touch exist, so an unexpected access fails the test.
  const session = {
    disposed: false,
    transport: { getPtyId: () => REMOTE_PTY_ID },
    pane: { terminal: { id: 'xterm-1' } },
    beforeTerminalOutputWrite: vi.fn(),
    canUseHiddenOutputSnapshot: () => true,
    hiddenOutputRestoreRemoteOutcomeAttempts: 0,
    hiddenOutputRestoreLocalGateAttempts: 0,
    markHiddenOutputRestoreNeeded: vi.fn(),
    ...overrides
  } as unknown as ConnectPanePtySession
  bindParkRevealSnapshotVerdictActions(session)
  return session
}

describe('warnParkRevealNoHostImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the no-host-image banner into a remote pane, pen reset, no CAN byte', () => {
    const session = buildSession()

    expect(session.warnParkRevealNoHostImage(REMOTE_PTY_ID, 'unavailable')).toBe(true)

    expect(writeTerminalOutput).toHaveBeenCalledExactlyOnceWith(
      session.pane.terminal,
      `\x1b[0m${PARK_REVEAL_NO_HOST_IMAGE_WARNING}`,
      { foreground: true, beforeWrite: session.beforeTerminalOutputWrite }
    )
    expect(writeTerminalOutput.mock.calls[0]?.[1]).not.toContain('\x18')
  })

  it('stays silent for a local pane, whose layout copy is never released', () => {
    const session = buildSession({ transport: { getPtyId: () => LOCAL_PTY_ID } })

    expect(session.warnParkRevealNoHostImage(LOCAL_PTY_ID, 'unavailable')).toBe(false)

    expect(writeTerminalOutput).not.toHaveBeenCalled()
  })

  it('does not banner a pane whose transport has moved on', () => {
    const session = buildSession({ transport: { getPtyId: () => 'remote:env-1@@pty-2' } })

    expect(session.warnParkRevealNoHostImage(REMOTE_PTY_ID, 'permanently-unavailable')).toBe(false)

    expect(writeTerminalOutput).not.toHaveBeenCalled()
  })
})

describe('retryUnverifiableParkRevealSnapshot', () => {
  it('charges the reveal probe to the host budget and hands off to the restore loop', () => {
    const session = buildSession()

    expect(session.retryUnverifiableParkRevealSnapshot('remote:env-1@@pty-1', 'host')).toBe(true)

    expect(session.hiddenOutputRestoreRemoteOutcomeAttempts).toBe(1)
    expect(session.hiddenOutputRestoreLocalGateAttempts).toBe(0)
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalledOnce()
  })

  it('charges a local gate to the local budget only', () => {
    const session = buildSession()

    session.retryUnverifiableParkRevealSnapshot('remote:env-1@@pty-1', 'local')

    expect(session.hiddenOutputRestoreRemoteOutcomeAttempts).toBe(0)
    expect(session.hiddenOutputRestoreLocalGateAttempts).toBe(1)
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalledOnce()
  })

  it('charges nothing for a legacy host but still hands off', () => {
    const session = buildSession()

    session.retryUnverifiableParkRevealSnapshot('remote:env-1@@pty-1', null)

    expect(session.hiddenOutputRestoreRemoteOutcomeAttempts).toBe(0)
    expect(session.hiddenOutputRestoreLocalGateAttempts).toBe(0)
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalledOnce()
  })

  it.each([
    [
      'the transport moved to another PTY',
      { transport: { getPtyId: () => 'remote:env-1@@pty-2' } }
    ],
    ['the session is disposed', { disposed: true }],
    ['no hidden snapshot source exists', { canUseHiddenOutputSnapshot: () => false }]
  ])('does nothing when %s', (_label, overrides) => {
    const session = buildSession(overrides)

    expect(session.retryUnverifiableParkRevealSnapshot('remote:env-1@@pty-1', 'host')).toBe(false)

    expect(session.hiddenOutputRestoreRemoteOutcomeAttempts).toBe(0)
    expect(session.markHiddenOutputRestoreNeeded).not.toHaveBeenCalled()
  })
})
