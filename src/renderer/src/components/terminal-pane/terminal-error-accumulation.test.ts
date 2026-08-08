import { describe, expect, it } from 'vitest'
import {
  appendTerminalErrorMessage,
  capTerminalErrorSurfaceNewest,
  MAX_TERMINAL_ERROR_SURFACE_CHARS
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

  it('caps a storm of distinct messages so the surface cannot grow unbound (#12685)', () => {
    let surface: string | null = null
    for (let i = 0; i < 200; i += 1) {
      surface = appendTerminalErrorMessage(surface, `Distinct error number ${i}.`)
    }
    expect(surface!.length).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_SURFACE_CHARS)
    // Newest messages survive the cap.
    expect(surface).toContain('Distinct error number 199.')
    expect(surface).not.toContain('Distinct error number 0.')
  })

  it('cuts the capped suffix on a newline when possible', () => {
    const text = `${'a'.repeat(100)}\nnewest-line`
    expect(capTerminalErrorSurfaceNewest(text, 20)).toBe('newest-line')
  })

  it('keeps the head of a single oversized line so SSH prefixes survive', () => {
    const owned = `SSH connection failed: ${'x'.repeat(3_000)}`
    const capped = capTerminalErrorSurfaceNewest(owned, 80)
    expect(capped.startsWith('SSH connection failed:')).toBe(true)
    expect(capped.length).toBe(80)
  })
})
