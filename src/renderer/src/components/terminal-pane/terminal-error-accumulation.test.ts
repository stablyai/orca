import { describe, expect, it } from 'vitest'
import {
  appendPaneTerminalError,
  appendTerminalErrorMessage,
  boundTerminalErrorSurface,
  clearPaneTerminalError,
  mapPaneTerminalErrors,
  MAX_TERMINAL_ERROR_CHARS,
  MAX_TERMINAL_ERROR_LINES,
  terminalErrorForPane
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

  it('caps a distinct error storm to the newest lines', () => {
    let accumulated: string | null = null
    for (let index = 0; index < MAX_TERMINAL_ERROR_LINES + 12; index += 1) {
      accumulated = appendTerminalErrorMessage(accumulated, `timeout #${index}`)
    }

    const lines = accumulated?.split('\n') ?? []
    expect(lines).toHaveLength(MAX_TERMINAL_ERROR_LINES)
    expect(lines[0]).toBe('timeout #12')
    expect(lines.at(-1)).toBe(`timeout #${MAX_TERMINAL_ERROR_LINES + 11}`)
  })

  it('drops a clipped leading line under the character budget', () => {
    const latestLine = 'SSH connection failed: host unreachable'
    const huge = `${'x'.repeat(MAX_TERMINAL_ERROR_CHARS + 500)}\n${latestLine}`

    expect(boundTerminalErrorSurface(huge)).toBe(latestLine)
  })
})

describe('pane terminal errors', () => {
  it('shows only the active pane errors beside a tab-wide error', () => {
    let errors = appendPaneTerminalError({}, 1, 'Pane one failed.')
    errors = appendPaneTerminalError(errors, 2, 'Pane two failed.')

    expect(terminalErrorForPane('Paste failed.', errors, 1)).toBe('Paste failed.\nPane one failed.')
    expect(terminalErrorForPane(null, errors, 2)).toBe('Pane two failed.')
    expect(terminalErrorForPane(null, errors, 3)).toBeNull()
  })

  it('clears only the recovered message for the matching pane', () => {
    let errors = appendPaneTerminalError({}, 1, 'Remote terminal was closed.')
    errors = appendPaneTerminalError(errors, 1, 'Paste failed.')
    errors = appendPaneTerminalError(errors, 2, 'Remote terminal was closed.')

    const cleared = clearPaneTerminalError(errors, 1, 'Remote terminal was closed.')

    expect(terminalErrorForPane(null, cleared, 1)).toBe('Paste failed.')
    expect(terminalErrorForPane(null, cleared, 2)).toBe('Remote terminal was closed.')
  })

  it('maps reconnect-owned lines without changing unrelated pane messages', () => {
    let errors = appendPaneTerminalError({}, 1, 'SSH connection failed: host unreachable')
    errors = appendPaneTerminalError(errors, 1, MULTILINE_ERROR)
    errors = appendPaneTerminalError(errors, 2, 'Paste failed.')

    const mapped = mapPaneTerminalErrors(errors, stripSshReconnectOwnedErrorLines)

    expect(terminalErrorForPane(null, mapped, 1)).toBe(MULTILINE_ERROR)
    expect(terminalErrorForPane(null, mapped, 2)).toBe('Paste failed.')
  })

  it('bounds distinct errors retained for one pane', () => {
    let errors = {}
    for (let index = 0; index < 20; index += 1) {
      errors = appendPaneTerminalError(errors, 1, `Failure ${index}`)
    }

    expect(terminalErrorForPane(null, errors, 1)?.split('\n')).toEqual(
      Array.from({ length: 8 }, (_, index) => `Failure ${index + 12}`)
    )
  })

  it('bounds individual pane errors and their joined display', () => {
    let errors = appendPaneTerminalError(
      {},
      1,
      Array.from({ length: MAX_TERMINAL_ERROR_LINES + 4 }, (_, index) => `line ${index}`).join('\n')
    )
    errors = appendPaneTerminalError(errors, 1, 'y'.repeat(MAX_TERMINAL_ERROR_CHARS + 500))

    const visible = terminalErrorForPane(null, errors, 1)

    expect(visible?.split('\n').length).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_LINES)
    expect(visible?.length).toBeLessThanOrEqual(MAX_TERMINAL_ERROR_CHARS)
    const cleared = clearPaneTerminalError(errors, 1, 'y'.repeat(MAX_TERMINAL_ERROR_CHARS + 500))
    expect(cleared[1]).toHaveLength(1)
  })

  it('releases closed pane entries across monotonically increasing pane ids', () => {
    let errors = appendPaneTerminalError({}, 1, 'Surviving pane failed.')
    for (let paneId = 2; paneId < 1_002; paneId += 1) {
      errors = appendPaneTerminalError(errors, paneId, `Closed pane ${paneId} failed.`)
      errors = clearPaneTerminalError(errors, paneId)
    }

    expect(errors).toEqual({ 1: ['Surviving pane failed.'] })
  })
})
