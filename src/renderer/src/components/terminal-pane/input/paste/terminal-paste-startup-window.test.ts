import { describe, expect, it } from 'vitest'
import {
  isTerminalStartingForPaste,
  observeTerminalStartupPasteOutput,
  resetTerminalStartupPasteWindow
} from './terminal-paste-startup-window'

describe('terminal startup paste window', () => {
  it('ends once the shell enables bracketed paste, even when output splits the sequence', () => {
    const terminal = { modes: { bracketedPasteMode: false } }
    observeTerminalStartupPasteOutput(terminal, 'prompt \u001b[?20', 0)
    observeTerminalStartupPasteOutput(terminal, '04h$ ', 1)

    expect(isTerminalStartingForPaste(terminal, 2)).toBe(false)
  })

  it('starts the window at the first output, not at a paste made before it', () => {
    const terminal = { modes: { bracketedPasteMode: false } }
    expect(isTerminalStartingForPaste(terminal, 0)).toBe(true)
    observeTerminalStartupPasteOutput(terminal, 'loading profile', 20_000)

    expect(isTerminalStartingForPaste(terminal, 20_001)).toBe(true)
    expect(isTerminalStartingForPaste(terminal, 31_000)).toBe(false)
  })

  it('gives a restarted shell in the same terminal a fresh window', () => {
    const terminal = { modes: { bracketedPasteMode: false } }
    observeTerminalStartupPasteOutput(terminal, '\u001b[?2004h$ ', 0)
    resetTerminalStartupPasteWindow(terminal)
    observeTerminalStartupPasteOutput(terminal, 'loading profile', 60_000)

    expect(isTerminalStartingForPaste(terminal, 60_001)).toBe(true)
  })
})
