import { describe, expect, it, vi } from 'vitest'
import {
  markTerminalBracketedPasteInterrupted,
  observeTerminalBracketedPasteModeOutput,
  pasteTerminalText,
  sanitizeTerminalPasteText
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
  it('temporarily ignores bracketed paste wrappers for single-line paste after Ctrl+C', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    pasteTerminalText(terminal, 'a69ce28e1d092e0c8825cd1a109ac36409962bc1')

    expect(terminal.paste).toHaveBeenCalledWith('a69ce28e1d092e0c8825cd1a109ac36409962bc1')
    expect(observedIgnoreValues).toEqual([true])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('keeps bracketed paste behavior for multi-line paste after Ctrl+C', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    pasteTerminalText(terminal, 'echo one\necho two')

    expect(terminal.paste).toHaveBeenCalledWith('echo one\necho two')
    expect(observedIgnoreValues).toEqual([false])
  })

  it('forces bracketed paste behavior when requested after Ctrl+C', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.input.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    pasteTerminalText(terminal, '/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true
    })

    expect(terminal.input).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(observedIgnoreValues).toEqual([false])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('forces bracketed paste behavior even when terminal mode is off', () => {
    const terminal = createTerminal(false)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.input.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    pasteTerminalText(terminal, '/tmp/orca-paste-1760000000000-id.png', {
      forceBracketedPaste: true
    })

    expect(terminal.input).toHaveBeenCalledWith(
      '\x1b[200~/tmp/orca-paste-1760000000000-id.png\x1b[201~'
    )
    expect(terminal.paste).not.toHaveBeenCalled()
    expect(observedIgnoreValues).toEqual([false])
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
  })

  it('renders embedded escape bytes inert when forcing bracketed paste', () => {
    const terminal = createTerminal(false)

    pasteTerminalText(terminal, '/tmp/before\x1b[201~after.png', {
      forceBracketedPaste: true
    })

    expect(terminal.input).toHaveBeenCalledWith('\x1b[200~/tmp/before\u241b[201~after.png\x1b[201~')
    expect(terminal.paste).not.toHaveBeenCalled()
  })

  it('does not change paste behavior when Ctrl+C happened outside bracketed paste mode', () => {
    const terminal = createTerminal(false)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    pasteTerminalText(terminal, 'commit')

    expect(terminal.paste).toHaveBeenCalledWith('commit')
    expect(observedIgnoreValues).toEqual([false])
  })

  it('clears the interrupted state when live output refreshes bracketed paste mode', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    observeTerminalBracketedPasteModeOutput(terminal, '\x1b[?25;2004h')
    pasteTerminalText(terminal, 'commit')

    expect(observedIgnoreValues).toEqual([false])
  })

  it('clears the interrupted state when bracketed paste mode output is split', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    observeTerminalBracketedPasteModeOutput(terminal, '\x1b[?20')
    observeTerminalBracketedPasteModeOutput(terminal, '04h')
    pasteTerminalText(terminal, 'commit')

    expect(observedIgnoreValues).toEqual([false])
  })

  it('clears the interrupted state when bracketed paste disable output is split', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    observeTerminalBracketedPasteModeOutput(terminal, '\x1b[?20')
    observeTerminalBracketedPasteModeOutput(terminal, '04l')
    pasteTerminalText(terminal, 'commit')

    expect(observedIgnoreValues).toEqual([false])
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

  it('clears the interrupted state when the terminal mode is already disabled', () => {
    const terminal = createTerminal(true)
    const observedIgnoreValues: (boolean | undefined)[] = []
    terminal.paste.mockImplementation(() => {
      observedIgnoreValues.push(terminal.options.ignoreBracketedPasteMode)
    })

    markTerminalBracketedPasteInterrupted(terminal)
    terminal.modes.bracketedPasteMode = false
    pasteTerminalText(terminal, 'commit')
    terminal.modes.bracketedPasteMode = true
    pasteTerminalText(terminal, 'next')

    expect(observedIgnoreValues).toEqual([false, false])
  })

  it('renders embedded escape bytes inert when forcing plain single-line paste', () => {
    const terminal = createTerminal(true)

    markTerminalBracketedPasteInterrupted(terminal)
    pasteTerminalText(terminal, 'before\x1b[201~after')

    expect(terminal.paste).toHaveBeenCalledWith('before\u241b[201~after')
  })

  it('sanitizes escape-heavy paste text without split arrays', () => {
    const text = Array.from({ length: 512 }, (_value, index) => `part-${index}\x1b[201~`).join('')
    const splitSpy = vi.spyOn(String.prototype, 'split')

    const sanitized = sanitizeTerminalPasteText(text)
    const splitCallCount = splitSpy.mock.calls.length
    splitSpy.mockRestore()

    expect(sanitized).not.toContain('\x1b')
    expect(sanitized).toContain('\u241b[201~')
    expect(splitCallCount).toBe(0)
  })

  it('detects escape-heavy bracketed mode output without split arrays', () => {
    const terminal = createTerminal(true)
    markTerminalBracketedPasteInterrupted(terminal)
    const output = `${Array.from({ length: 512 }, () => '\x1b]noise').join('')}\x1b[?25;2004h`
    const splitSpy = vi.spyOn(String.prototype, 'split')

    observeTerminalBracketedPasteModeOutput(terminal, output)
    const splitCallCount = splitSpy.mock.calls.length
    splitSpy.mockRestore()

    pasteTerminalText(terminal, 'commit')
    expect(terminal.paste).toHaveBeenCalledWith('commit')
    expect(terminal.options.ignoreBracketedPasteMode).toBe(false)
    expect(splitCallCount).toBe(0)
  })
})
