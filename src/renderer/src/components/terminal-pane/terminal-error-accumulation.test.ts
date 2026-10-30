import { describe, expect, it } from 'vitest'
import {
  appendPaneTerminalError,
  appendTerminalErrorMessage,
  clearPaneTerminalError,
  mapPaneTerminalErrors,
  MAX_TERMINAL_ERROR_CHARS,
  MAX_TERMINAL_ERROR_LINES,
  terminalErrorForPane
} from './terminal-error-accumulation'
import { stripSshReconnectOwnedErrorLines } from './TerminalErrorToast'

const MULTILINE_ERROR = 'Remote terminal write failed.\nThe remote runtime rejected the request.'

describe('appendTerminalErrorMessage', () => {
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
})

describe('pane terminal errors', () => {
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
