import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  POST_REPLAY_LIVE_AGENT_REATTACH_RESET,
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_KITTY_KEYBOARD_PROTOCOL,
  RESET_TERMINAL_CURSOR_STYLE
} from '../../../../shared/terminal-mode-reset-profiles'

const OLD_REATTACH_RESET_WITHOUT_CURSOR_STYLE = '\x1b[?25h\x1b[?1004l'

type DecPrivateCursorState = {
  cursorStyle?: string
  cursorBlink?: boolean
  sendFocus?: boolean
}

type KittyKeyboardState = {
  flags: number
  mainFlags: number
  altFlags: number
  mainStack: number[]
  altStack: number[]
}

type XtermWithCoreService = Terminal & {
  _core?: {
    coreService?: {
      decPrivateModes?: DecPrivateCursorState
      kittyKeyboard?: KittyKeyboardState
      isCursorHidden?: boolean
    }
    _coreService?: {
      decPrivateModes?: DecPrivateCursorState
      kittyKeyboard?: KittyKeyboardState
      isCursorHidden?: boolean
    }
  }
}

function readDecPrivateCursorState(term: Terminal): DecPrivateCursorState {
  const core = (term as XtermWithCoreService)._core
  const cursorState = core?.coreService?.decPrivateModes ?? core?._coreService?.decPrivateModes
  return cursorState ? { ...cursorState } : {}
}

function readCursorHidden(term: Terminal): boolean | undefined {
  const core = (term as XtermWithCoreService)._core
  return core?.coreService?.isCursorHidden ?? core?._coreService?.isCursorHidden
}

function readSendFocus(term: Terminal): boolean | undefined {
  return readDecPrivateCursorState(term).sendFocus
}

function readKittyKeyboardState(term: Terminal): KittyKeyboardState | null {
  const core = (term as XtermWithCoreService)._core
  const keyboardState = core?.coreService?.kittyKeyboard ?? core?._coreService?.kittyKeyboard
  return keyboardState
    ? {
        flags: keyboardState.flags,
        mainFlags: keyboardState.mainFlags,
        altFlags: keyboardState.altFlags,
        mainStack: [...keyboardState.mainStack],
        altStack: [...keyboardState.altStack]
      }
    : null
}

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

describe('terminal replay state reset', () => {
  it('includes Kitty keyboard protocol reset in replay reset bundles', () => {
    expect(RESET_KITTY_KEYBOARD_PROTOCOL).toBe('\x1b[<99u\x1b[=0u')
    expect(POST_REPLAY_MODE_RESET).toContain(RESET_KITTY_KEYBOARD_PROTOCOL)
    expect(POST_REPLAY_REATTACH_RESET).toContain(RESET_KITTY_KEYBOARD_PROTOCOL)
    expect(POST_REPLAY_LIVE_SNAPSHOT_RESET).not.toContain(RESET_KITTY_KEYBOARD_PROTOCOL)
  })

  it('clears stale DECSCUSR cursor overrides after live reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      cursorStyle: 'bar',
      cursorBlink: true
    })

    try {
      await writeTerminal(term, '\x1b[2 q')
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'block',
        cursorBlink: false
      })

      await writeTerminal(term, OLD_REATTACH_RESET_WITHOUT_CURSOR_STYLE)
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'block',
        cursorBlink: false
      })

      await writeTerminal(term, POST_REPLAY_REATTACH_RESET)
      const cursorState = readDecPrivateCursorState(term)
      expect(cursorState.cursorStyle).toBeUndefined()
      expect(cursorState.cursorBlink).toBeUndefined()
    } finally {
      term.dispose()
    }
  })

  it('clears stale DECSCUSR cursor overrides after cold-restore replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      cursorStyle: 'bar',
      cursorBlink: true
    })

    try {
      await writeTerminal(term, '\x1b[6 q')
      expect(readDecPrivateCursorState(term)).toMatchObject({
        cursorStyle: 'bar',
        cursorBlink: false
      })

      await writeTerminal(term, POST_REPLAY_MODE_RESET)
      const cursorState = readDecPrivateCursorState(term)
      expect(cursorState.cursorStyle).toBeUndefined()
      expect(cursorState.cursorBlink).toBeUndefined()
    } finally {
      term.dispose()
    }
  })

  it('clears active-buffer Kitty keyboard state after live reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    })

    try {
      await writeTerminal(term, '\x1b[=31u\x1b[>15u')
      expect(readKittyKeyboardState(term)).toMatchObject({
        flags: 15,
        mainStack: [31]
      })

      await writeTerminal(term, POST_REPLAY_REATTACH_RESET)
      // Why: after renderer reattach, the next Ctrl+C must not inherit a stale
      // Kitty CSI-u encoder state from the replayed TUI snapshot.
      expect(readKittyKeyboardState(term)).toMatchObject({
        flags: 0,
        mainFlags: 0,
        mainStack: []
      })
    } finally {
      term.dispose()
    }
  })

  it('clears active-buffer Kitty keyboard state with the idle-agent reset sequence', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    })

    try {
      await writeTerminal(term, '\x1b[=31u\x1b[>15u')
      expect(readKittyKeyboardState(term)).toMatchObject({
        flags: 15,
        mainStack: [31]
      })

      await writeTerminal(term, `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}`)
      // Why: this is the exact reset emitted when a native Windows agent turn
      // completes, so the next Backspace/Enter must not inherit CSI-u encoding.
      expect(readKittyKeyboardState(term)).toMatchObject({
        flags: 0,
        mainFlags: 0,
        mainStack: []
      })
    } finally {
      term.dispose()
    }
  })

  it('resets hidden cursor visibility after ordinary reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true
    })

    try {
      await writeTerminal(term, '\x1b[?25l')
      expect(readCursorHidden(term)).toBe(true)

      await writeTerminal(term, POST_REPLAY_REATTACH_RESET)

      expect(readCursorHidden(term)).toBe(false)
    } finally {
      term.dispose()
    }
  })

  it('resets focus reporting after ordinary reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true
    })
    try {
      await writeTerminal(term, '\x1b[?1004h')
      expect(readSendFocus(term)).toBe(true)

      await writeTerminal(term, POST_REPLAY_REATTACH_RESET)

      expect(readSendFocus(term)).toBe(false)
    } finally {
      term.dispose()
    }
  })

  it('resets hidden cursor visibility after live agent reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true
    })

    try {
      await writeTerminal(term, '\x1b[?25l')
      expect(readCursorHidden(term)).toBe(true)

      await writeTerminal(term, POST_REPLAY_LIVE_AGENT_REATTACH_RESET)

      // Why: agent detection can false-positive on a dead TUI's leftovers, so
      // even the live-agent reset must not leave a shell cursor permanently
      // invisible; a live agent re-hides it on the post-reattach repaint.
      expect(readCursorHidden(term)).toBe(false)
    } finally {
      term.dispose()
    }
  })

  it('preserves live focus reporting after live agent reattach replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true
    })
    try {
      await writeTerminal(term, '\x1b[?1004h')
      expect(readSendFocus(term)).toBe(true)

      await writeTerminal(term, POST_REPLAY_LIVE_AGENT_REATTACH_RESET)

      // Why: live TUIs such as cursor-agent can rely on focus events to repaint
      // their own hidden-cursor input caret after renderer reattach.
      expect(readSendFocus(term)).toBe(true)
    } finally {
      term.dispose()
    }
  })

  it('shows the cursor after cold-restore replay reset', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true
    })

    try {
      await writeTerminal(term, '\x1b[?25l')
      expect(readCursorHidden(term)).toBe(true)

      await writeTerminal(term, POST_REPLAY_MODE_RESET)

      expect(readCursorHidden(term)).toBe(false)
    } finally {
      term.dispose()
    }
  })

  it('preserves active-buffer Kitty keyboard state after hidden-output snapshot replay', async () => {
    const term = new Terminal({
      cols: 80,
      rows: 24,
      allowProposedApi: true,
      vtExtensions: { kittyKeyboard: true }
    })

    try {
      await writeTerminal(term, '\x1b[=31u\x1b[>15u')
      await writeTerminal(term, POST_REPLAY_LIVE_SNAPSHOT_RESET)

      expect(readKittyKeyboardState(term)).toMatchObject({
        flags: 15,
        mainStack: [31]
      })
    } finally {
      term.dispose()
    }
  })

  it('keeps absolute cursor rows when capture-grid bytes are replayed at their capture dims', async () => {
    // Why: background agents / daemon snapshots encode layout at their source
    // grid. Replaying those bytes into a differently-sized xterm rewraps or
    // clamps CUP targets, so inline TUIs (Cursor CLI) park the block cursor
    // below the input box. Capture-size replay then fit-back is the fix.
    const captureCols = 120
    const captureRows = 40
    const paneCols = 80
    const paneRows = 24
    // Absolute CUP to the bottom input row of a 40-row screen, then type.
    const frame = '\x1b[2J\x1b[H\x1b[38;1H> prompt'

    const mismatched = new Terminal({
      cols: paneCols,
      rows: paneRows,
      allowProposedApi: true
    })
    const matched = new Terminal({
      cols: paneCols,
      rows: paneRows,
      allowProposedApi: true
    })

    try {
      await writeTerminal(mismatched, frame)
      // CUP 38 clamps on a 24-row terminal — cursor lands on the last row.
      expect(mismatched.buffer.active.cursorY).toBe(paneRows - 1)

      matched.resize(captureCols, captureRows)
      await writeTerminal(matched, frame)
      // Same frame at capture dims parks the cursor on row 38 (0-indexed 37).
      expect(matched.buffer.active.cursorY).toBe(37)
      expect(matched.buffer.active.getLine(37)?.translateToString(true)).toContain('> prompt')

      // Fit-back to the pane grid (mirrors safeFit after capture-size replay).
      // The live TUI then receives a SIGWINCH and repaints from the correctly
      // placed cursor model — the bug path never reaches that point because
      // the mismatched parse already clamped CUP 38 onto the last pane row.
      matched.resize(paneCols, paneRows)
      expect(mismatched.buffer.active.cursorY).not.toBe(37)
    } finally {
      mismatched.dispose()
      matched.dispose()
    }
  })
})
