import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'
import { TerminalIdleCursorReset } from '../terminal-idle-cursor-reset'
import { TerminalStreamPosition } from '../terminal-stream-position'
import { createTerminalInputEchoDelay } from './terminal-input-echo-delay'

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  writeTerminalOutput: (terminal: Terminal, data: string) => terminal.write(data)
}))
vi.mock('@/lib/pane-manager/terminal-render-pause-release', () => ({
  forceFullViewportPresent: vi.fn()
}))
vi.mock('@/lib/pane-manager/terminal-delivery-credit', () => ({
  takeCurrentTerminalDeliveryCredit: () => undefined
}))

const terminals: Terminal[] = []
afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    terminal.dispose()
  }
})

function createSession() {
  const terminal = new Terminal({ cols: 80, rows: 5, allowProposedApi: true })
  terminals.push(terminal)
  const session = {
    disposed: false,
    idleCursorReset: new TerminalIdleCursorReset(),
    streamPosition: new TerminalStreamPosition(),
    inputEchoDelay: createTerminalInputEchoDelay(),
    deps: { isVisibleRef: { current: true } },
    kittyKeyboardModes: { scan: vi.fn() },
    resetHiddenOutputRestoreIfPtyChanged: vi.fn(),
    transport: { getPtyId: () => 'pty-1' },
    canUseHiddenOutputSnapshot: () => false,
    shouldSnapshotHiddenCodexOutput: false,
    shouldProtectNativeWindowsSynchronizedOutput: false,
    shouldApplyNativeWindowsRewriteRefresh: false,
    scheduleForegroundGridDriftCheck: vi.fn(),
    shouldForceForegroundRenderRefresh: () => ({
      refresh: false,
      inPlaceRewrite: false
    }),
    isLatencySensitiveForegroundOutput: () => false,
    markHiddenOutputRestoreNeeded: vi.fn(),
    hiddenOutputRestoreNeeded: false,
    hiddenOutputRestoreInFlight: null,
    isForegroundRestoreBackpressureContext: () => false,
    noteHiddenOutputRestoreFloodBackpressure: vi.fn(),
    skippedQueryCarry: null,
    salvageRendererQueriesFromDiscardedRestoreData: vi.fn((data: string, pending = ''): string => {
      const joined = pending + data
      return joined.slice(joined.lastIndexOf('\x1b'))
    }),
    // Replaced by bindWritePtyOutputToXterm.
    admitStreamBytes: (
      _data: string,
      _delivered: { data: string; seq?: number; midEscape?: true | 'unknown' }
    ): string | null => null,
    admitRecoveryBytes: (_data: string): string => _data,
    writePtyOutputToXterm: (_data: string, _foreground: boolean): void => {},
    queueAgentIdleTerminalModeReset: (): void => {},
    pane: { terminal }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the fields used by this binding; xterm itself is real.
  bindWritePtyOutputToXterm(session as never)
  return session
}

describe('admission at the stream position', () => {
  it('answers a query split across two skipped deliveries that continue each other', () => {
    const session = createSession()
    session.streamPosition.anchor('pty-1', 0)
    const salvage = session.salvageRendererQueriesFromDiscardedRestoreData
    // Bytes 0..10 were lost; both deliveries start inside escapes main saw open.
    expect(
      session.admitStreamBytes('42B\x1b[6', { data: '42B\x1b[6', seq: 15, midEscape: true })
    ).toBeNull()
    expect(session.admitStreamBytes('n', { data: 'n', seq: 16, midEscape: true })).toBeNull()
    expect(salvage).toHaveBeenLastCalledWith('n', '\x1b[6')
    // A delivery that does not continue the last skip starts a fresh carry.
    expect(session.admitStreamBytes('x', { data: 'x', seq: 30, midEscape: true })).toBeNull()
    expect(salvage).toHaveBeenLastCalledWith('x', '')
    // Nor does one from another PTY at the same seq.
    expect(
      session.admitStreamBytes('42B\x1b[6', { data: '42B\x1b[6', seq: 50, midEscape: true })
    ).toBeNull()
    session.transport.getPtyId = () => 'pty-2'
    session.streamPosition.anchor('pty-2', 0)
    expect(session.admitStreamBytes('n', { data: 'n', seq: 51, midEscape: true })).toBeNull()
    expect(salvage).toHaveBeenLastCalledWith('n', '')
    // The skipped bytes are repaired by a snapshot restore.
    expect(session.markHiddenOutputRestoreNeeded).toHaveBeenCalled()
  })

  it('takes xterm off the stream when recovery bytes are written', () => {
    const session = createSession()
    session.streamPosition.anchor('pty-1', 10)
    expect(session.admitRecoveryBytes('\x1b[6n')).toBe('\x1b[6n')
    // The exact continuation at 10 no longer holds; a mid-escape start is skipped.
    expect(session.admitStreamBytes('2C', { data: '2C', seq: 12, midEscape: true })).toBeNull()
  })
})
