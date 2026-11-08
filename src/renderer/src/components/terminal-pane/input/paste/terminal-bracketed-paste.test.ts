import { describe, expect, it, vi } from 'vitest'
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput,
  pasteTerminalText
} from './terminal-bracketed-paste'

function createTerminal(bracketedPasteMode = true) {
  const terminal = {
    modes: {
      bracketedPasteMode
    },
    options: {
      ignoreBracketedPasteMode: false as boolean | undefined
    },
    input: vi.fn(),
    paste: vi.fn()
  }
  return terminal
}

describe('terminal bracketed paste policy', () => {
  it('encodes Windows input-record newlines atomically and sanitizes escape bytes', () => {
    const terminal = createTerminal(false)

    pasteTerminalText(terminal, '\none\r\ntwo\x1b[201~', {
      windowsInputRecordNewline: 'alt-enter'
    })

    expect(terminal.input).toHaveBeenCalledWith('\x1b\rone\x1b\rtwo␛[201~')
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('ignores partial mode output seen before an interrupt', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    observeTerminalBracketedPasteModeOutput(terminal, '\x1b[?20')
    markTerminalBracketedPasteInterrupted(terminal)
    observeTerminalBracketedPasteModeOutput(terminal, '04h')
    pasteTerminalText(terminal, 'commit')

    expect(observedIgnoreValues).toEqual([true])
  })

  it('detects split compound bracketed paste mode output', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    observeTerminalBracketedPasteModeOutput(terminal, '\x1b[?25;1000;1002;1003;1004;1006;20')
    observeTerminalBracketedPasteModeOutput(terminal, '04h')
    pasteTerminalText(terminal, 'commit')

    expect(observedIgnoreValues).toEqual([false])
  })
})
