import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import {
  POST_REPLAY_LIVE_SNAPSHOT_RESET,
  POST_REPLAY_MODE_RESET,
  POST_REPLAY_REATTACH_RESET,
  RESET_KITTY_KEYBOARD_PROTOCOL
} from './layout-serialization'

const OLD_REATTACH_RESET_WITHOUT_CURSOR_STYLE = '\x1b[?25h\x1b[?1004l'

type DecPrivateCursorState = {
  cursorStyle?: string
  cursorBlink?: boolean
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
    }
    _coreService?: {
      decPrivateModes?: DecPrivateCursorState
      kittyKeyboard?: KittyKeyboardState
    }
  }
}

function readDecPrivateCursorState(term: Terminal): DecPrivateCursorState {
  const core = (term as XtermWithCoreService)._core
  const cursorState = core?.coreService?.decPrivateModes ?? core?._coreService?.decPrivateModes
  return cursorState ? { ...cursorState } : {}
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
})
