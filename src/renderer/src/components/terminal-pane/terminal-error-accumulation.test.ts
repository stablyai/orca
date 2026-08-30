import { describe, expect, it } from 'vitest'
import { appendTerminalErrorMessage } from './terminal-error-accumulation'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'

const MULTILINE_ERROR = 'Remote terminal write failed.\nThe remote runtime rejected the request.'

describe('appendTerminalErrorMessage', () => {
  it('starts the surface with the first message', () => {
    expect(appendTerminalErrorMessage(null, 'Paste failed.')).toBe('Paste failed.')
  })

  it('appends distinct messages as newline-joined entries', () => {
    const accumulated = appendTerminalErrorMessage(
      appendTerminalErrorMessage(null, 'Paste failed.'),
      'Remote terminal was closed.'
    )
    expect(accumulated).toBe('Paste failed.\nRemote terminal was closed.')
  })

  it('keeps the first occurrence of a repeated single-line message', () => {
    const accumulated = appendTerminalErrorMessage(null, 'Paste failed.')
    expect(appendTerminalErrorMessage(accumulated, 'Paste failed.')).toBe(accumulated)
  })

  it('does not re-append a repeated multi-line message', () => {
    let accumulated = appendTerminalErrorMessage(null, MULTILINE_ERROR)
    accumulated = appendTerminalErrorMessage(accumulated, MULTILINE_ERROR)
    accumulated = appendTerminalErrorMessage(accumulated, MULTILINE_ERROR)
    expect(accumulated).toBe(MULTILINE_ERROR)
  })

  it('detects a repeated multi-line message in any position of the surface', () => {
    const leading = appendTerminalErrorMessage(
      appendTerminalErrorMessage(null, MULTILINE_ERROR),
      'Paste failed.'
    )
    expect(appendTerminalErrorMessage(leading, MULTILINE_ERROR)).toBe(leading)

    const trailing = appendTerminalErrorMessage(
      appendTerminalErrorMessage(null, 'Paste failed.'),
      MULTILINE_ERROR
    )
    expect(appendTerminalErrorMessage(trailing, MULTILINE_ERROR)).toBe(trailing)

    const middle = appendTerminalErrorMessage(trailing, 'Remote terminal was closed.')
    expect(appendTerminalErrorMessage(middle, MULTILINE_ERROR)).toBe(middle)
  })

  it('keeps per-line dedup for a single-line message already present as a line', () => {
    const accumulated = appendTerminalErrorMessage(null, MULTILINE_ERROR)
    expect(appendTerminalErrorMessage(accumulated, 'Remote terminal write failed.')).toBe(
      accumulated
    )
  })

  it('appends a message that is only a substring of an existing line', () => {
    const accumulated = appendTerminalErrorMessage(null, MULTILINE_ERROR)
    expect(appendTerminalErrorMessage(accumulated, 'terminal write failed.')).toBe(
      `${MULTILINE_ERROR}\nterminal write failed.`
    )
  })

  it('#15241: bounds growth when a recurring error carries a changing timestamp', () => {
    let accumulated: string | null = null
    for (let i = 0; i < 500; i++) {
      accumulated = appendTerminalErrorMessage(
        accumulated,
        `Remote terminal write failed at 14:32:${String(i).padStart(2, '0')}.`
      )
    }
    // Why: none of these 500 messages are exact repeats (the timestamp differs each time),
    // so containsWholeLineRun never matches — without a cap this grows to 500 lines/~21KB.
    expect(accumulated?.split('\n').length).toBe(20)
    expect(accumulated).toContain('14:32:499')
    expect(accumulated).not.toContain('14:32:00.')
  })

  it('#15241: bounds a single oversized first message, not just repeated appends', () => {
    const oversizedFirstMessage = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const accumulated = appendTerminalErrorMessage(null, oversizedFirstMessage)
    expect(accumulated.split('\n').length).toBe(20)
    expect(accumulated).toContain('line 29')
    expect(accumulated).not.toContain('line 9\n')
  })

  it('#15241: keeps only the most recent lines once the cap is exceeded', () => {
    let accumulated: string | null = null
    for (let i = 0; i < 25; i++) {
      accumulated = appendTerminalErrorMessage(accumulated, `error ${i}`)
    }
    expect(accumulated).toBe(Array.from({ length: 20 }, (_, i) => `error ${i + 5}`).join('\n'))
  })

  it('stays a newline-joined string the toast can still filter per line', () => {
    const accumulated = appendTerminalErrorMessage(
      appendTerminalErrorMessage(null, 'SSH connection failed: host unreachable'),
      MULTILINE_ERROR
    )
    expect(stripSshReconnectOwnedErrorLines(accumulated)).toBe(MULTILINE_ERROR)
  })
})
