import { describe, expect, it } from 'vitest'
import {
  appendTerminalErrorMessage,
  boundTerminalErrorSurface,
  MAX_TERMINAL_ERROR_CHARS,
  MAX_TERMINAL_ERROR_LINES
} from './terminal-error-accumulation'
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

  it('stays a newline-joined string the toast can still filter per line', () => {
    const accumulated = appendTerminalErrorMessage(
      appendTerminalErrorMessage(null, 'SSH connection failed: host unreachable'),
      MULTILINE_ERROR
    )
    expect(stripSshReconnectOwnedErrorLines(accumulated)).toBe(MULTILINE_ERROR)
  })

  it('caps a distinct single-line error storm to the newest lines', () => {
    let accumulated: string | null = null
    for (let i = 0; i < MAX_TERMINAL_ERROR_LINES + 12; i += 1) {
      accumulated = appendTerminalErrorMessage(accumulated, `timeout #${i}`)
    }
    const lines = accumulated!.split('\n')
    expect(lines).toHaveLength(MAX_TERMINAL_ERROR_LINES)
    expect(lines[0]).toBe('timeout #12')
    expect(lines.at(-1)).toBe(`timeout #${MAX_TERMINAL_ERROR_LINES + 11}`)
  })

  it('keeps a closed character budget for oversized surfaces', () => {
    const huge = 'x'.repeat(MAX_TERMINAL_ERROR_CHARS + 500)
    const bounded = boundTerminalErrorSurface(huge)
    expect(bounded.length).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_CHARS)
    expect(bounded.endsWith('x')).toBe(true)
  })

  it('drops a clipped leading line after character truncation', () => {
    const latestLine = 'SSH connection failed: host unreachable'
    const huge = `${'x'.repeat(MAX_TERMINAL_ERROR_CHARS + 500)}\n${latestLine}`

    expect(boundTerminalErrorSurface(huge)).toBe(latestLine)
  })
})
