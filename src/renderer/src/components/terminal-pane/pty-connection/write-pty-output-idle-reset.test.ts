import { afterEach, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'
import { bindFreshSpawnFollowReset } from './fresh-spawn-follow-reset'
import { RESET_TERMINAL_CURSOR_STYLE } from '../../../../../shared/terminal-mode-reset-profiles'

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  writeTerminalOutput: (terminal: Terminal, data: string) => terminal.write(data),
  flushTerminalOutput: vi.fn()
}))
vi.mock('../replay-guard', () => ({
  replayIntoTerminal: (pane: { terminal: Terminal }, _replaying: unknown, data: string) =>
    pane.terminal.write(data),
  replayIntoTerminalAsync: (pane: { terminal: Terminal }, _replaying: unknown, data: string) =>
    new Promise<void>((resolve) => pane.terminal.write(data, resolve))
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
    deps: { isVisibleRef: { current: true } },
    kittyKeyboardModes: { scan: vi.fn() },
    resetHiddenOutputRestoreIfPtyChanged: vi.fn(),
    transport: { getPtyId: () => 'pty-1' },
    canUseHiddenOutputSnapshot: () => false,
    shouldSnapshotHiddenCodexOutput: false,
    shouldProtectNativeWindowsSynchronizedOutput: false,
    shouldApplyNativeWindowsRewriteRefresh: false,
    scheduleForegroundGridDriftCheck: vi.fn(),
    shouldForceForegroundRenderRefresh: () => ({ refresh: false, inPlaceRewrite: false }),
    isLatencySensitiveForegroundOutput: () => false,
    markHiddenOutputRestoreNeeded: vi.fn(),
    writePtyOutputToXterm: (_data: string, _foreground: boolean): void => {},
    queueAgentIdleTerminalModeReset: (): void => {},
    writeReplayData: (_data: string): void => {},
    writeReplayDataAsync: async (_data: string): Promise<void> => {},
    pane: { terminal }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies the fields used by this binding; xterm itself is real.
  bindWritePtyOutputToXterm(session as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the replay-write closures are invoked with this real-xterm fixture.
  bindFreshSpawnFollowReset(session as never)
  return session
}

function settledText(terminal: Terminal): Promise<string> {
  return new Promise((resolve) => {
    terminal.write('', () =>
      resolve(terminal.buffer.active.getLine(0)?.translateToString(true) ?? '')
    )
  })
}

describe('idle cursor reset during PTY output', () => {
  it.each([true, false])(
    'does not print a split color suffix (foreground=%s)',
    async (foreground) => {
      const session = createSession()
      session.deps.isVisibleRef.current = foreground
      session.writePtyOutputToXterm('\x1b[38;2;115;118;123;', foreground)
      session.queueAgentIdleTerminalModeReset()
      session.writePtyOutputToXterm('48;2;65;69;76m⠁', foreground)
      expect(await settledText(session.pane.terminal)).toBe('⠁')
    }
  )

  it('still writes the cursor reset at a complete boundary', () => {
    const session = createSession()
    const write = vi.spyOn(session.pane.terminal, 'write')
    session.queueAgentIdleTerminalModeReset()
    expect(write).toHaveBeenCalledWith(RESET_TERMINAL_CURSOR_STYLE)
  })

  it.each([false, true])('preserves a replayed parser tail (async=%s)', async (asyncReplay) => {
    const session = createSession()
    const prefix = '\x1b[38;2;115;118;123;'
    if (asyncReplay) {
      await session.writeReplayDataAsync(prefix)
    } else {
      session.writeReplayData(prefix)
    }
    session.queueAgentIdleTerminalModeReset()
    session.writePtyOutputToXterm('48;2;65;69;76m⠁', true)
    expect(await settledText(session.pane.terminal)).toBe('⠁')
  })

  it('does not write after disposal', () => {
    const session = createSession()
    const write = vi.spyOn(session.pane.terminal, 'write')
    session.disposed = true
    session.queueAgentIdleTerminalModeReset()
    expect(write).not.toHaveBeenCalled()
  })
})
