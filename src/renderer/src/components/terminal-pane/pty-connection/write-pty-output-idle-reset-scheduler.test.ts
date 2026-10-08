import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  discardTerminalOutput,
  flushTerminalOutput
} from '@/lib/pane-manager/pane-terminal-output-scheduler'
import { bindWritePtyOutputToXterm } from './write-pty-output-to-xterm'

const terminals: Terminal[] = []

afterEach(() => {
  for (const terminal of terminals.splice(0)) {
    discardTerminalOutput(terminal)
    terminal.dispose()
  }
  vi.unstubAllGlobals()
})

function createSession(foreground = false) {
  const terminal = new Terminal({
    cols: 80,
    rows: 5,
    allowProposedApi: true
  })
  terminals.push(terminal)
  const session = {
    disposed: false,
    deps: { isVisibleRef: { current: foreground } },
    kittyKeyboardModes: { scan: () => {} },
    resetHiddenOutputRestoreIfPtyChanged: () => {},
    transport: { getPtyId: () => 'pty-review-fixture' },
    canUseHiddenOutputSnapshot: () => false,
    shouldSnapshotHiddenCodexOutput: false,
    shouldProtectNativeWindowsSynchronizedOutput: false,
    shouldApplyNativeWindowsRewriteRefresh: false,
    scheduleForegroundGridDriftCheck: () => {},
    shouldForceForegroundRenderRefresh: () => ({ refresh: false, inPlaceRewrite: false }),
    isLatencySensitiveForegroundOutput: () => false,
    markHiddenOutputRestoreNeeded: () => {},
    writePtyOutputToXterm: (_data: string, _foreground: boolean): void => {},
    queueAgentIdleTerminalModeReset: (): void => {},
    pane: { terminal }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture supplies this binding's fields and uses the real scheduler and xterm parser.
  bindWritePtyOutputToXterm(session as never)
  return session
}

function settledText(terminal: Terminal): Promise<string> {
  return new Promise((resolve) => {
    terminal.write('', () => {
      const lines: string[] = []
      for (let row = 0; row < terminal.buffer.active.length; row++) {
        lines.push(terminal.buffer.active.getLine(row)?.translateToString(true) ?? '')
      }
      resolve(lines.join('\n'))
    })
  })
}

describe('idle cursor reset with the real output scheduler', () => {
  it('delivers a cursor reset at a complete boundary', async () => {
    vi.stubGlobal('window', globalThis)
    const session = createSession()
    const cursorCommands: (number | number[])[][] = []
    session.pane.terminal.parser.registerCsiHandler(
      { intermediates: ' ', final: 'q' },
      (params) => {
        cursorCommands.push(params)
        return false
      }
    )
    session.queueAgentIdleTerminalModeReset()
    flushTerminalOutput(session.pane.terminal)
    await settledText(session.pane.terminal)
    expect(cursorCommands).toEqual([[0]])
  })

  const cases = ['\x1b]0;', '\x1bP'].flatMap((prefix) =>
    [false, true].flatMap((foreground) =>
      [false, true].map((requestBeforeDrop) => ({ prefix, foreground, requestBeforeDrop }))
    )
  )

  it.each(cases)('preserves a reset across replacement in %j', async (testCase) => {
    vi.stubGlobal('window', globalThis)
    const { prefix, foreground, requestBeforeDrop } = testCase
    const session = createSession(foreground)
    const terminal = session.pane.terminal
    const cursorCommands: (number | number[])[][] = []
    terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      cursorCommands.push(params)
      return false
    })
    session.writePtyOutputToXterm(prefix, foreground)
    if (requestBeforeDrop) {
      session.queueAgentIdleTerminalModeReset()
    }
    for (let chunk = 0; chunk < 4; chunk++) {
      session.writePtyOutputToXterm('x'.repeat(512 * 1024), foreground)
    }
    session.writePtyOutputToXterm('after-cap\r\n', foreground)
    flushTerminalOutput(terminal)

    expect(await settledText(terminal)).toContain(
      foreground ? 'Orca skipped a burst of terminal output' : 'Orca skipped hidden terminal output'
    )
    if (!requestBeforeDrop) {
      session.queueAgentIdleTerminalModeReset()
    }
    flushTerminalOutput(terminal)
    await settledText(terminal)
    expect(cursorCommands).toEqual([[0]])
  })

  it('keeps parser state synchronized across repeated replacements before draining', async () => {
    vi.stubGlobal('window', globalThis)
    const session = createSession()
    const terminal = session.pane.terminal
    const cursorCommands: (number | number[])[][] = []
    terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      cursorCommands.push(params)
      return false
    })
    for (const prefix of ['\x1b]0;', '\x1bP']) {
      session.writePtyOutputToXterm(prefix, false)
      session.writePtyOutputToXterm('x'.repeat(3 * 1024 * 1024), false)
    }
    flushTerminalOutput(terminal)
    expect(await settledText(terminal)).toContain('Orca skipped hidden terminal output')
    session.queueAgentIdleTerminalModeReset()
    flushTerminalOutput(terminal)
    await settledText(terminal)
    expect(cursorCommands).toEqual([[0]])
  })

  it('preserves an unfinished sequence queued by recovery after replacement', async () => {
    vi.stubGlobal('window', globalThis)
    const session = createSession()
    const terminal = session.pane.terminal
    const cursorCommands: (number | number[])[][] = []
    terminal.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, (params) => {
      cursorCommands.push(params)
      return false
    })
    session.markHiddenOutputRestoreNeeded = () => {
      session.writePtyOutputToXterm('\x1b]0;restored-title', false)
    }
    session.writePtyOutputToXterm('\x1bP', false)
    session.writePtyOutputToXterm('x'.repeat(3 * 1024 * 1024), false)
    session.queueAgentIdleTerminalModeReset()
    flushTerminalOutput(terminal)
    await settledText(terminal)
    expect(cursorCommands).toEqual([])

    session.writePtyOutputToXterm('\x07', false)
    flushTerminalOutput(terminal)
    await settledText(terminal)
    expect(cursorCommands).toEqual([[0]])
  })
})
