import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractCodexAuthError, isCodexAuthError } from './codex-auth-errors'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('isCodexAuthError', () => {
  it('matches Codex authentication refresh failures', () => {
    expect(isCodexAuthError('Access token could not be refreshed')).toBe(true)
    expect(isCodexAuthError('plain provider error')).toBe(false)
    expect(isCodexAuthError(null)).toBe(false)
  })
})

describe('extractCodexAuthError', () => {
  it('returns the first matching auth line', () => {
    expect(
      extractCodexAuthError('startup log\nERROR: not logged in. Please sign in again.\nmore log')
    ).toBe('ERROR: not logged in. Please sign in again.')
  })

  it('strips ANSI color from matching lines', () => {
    expect(extractCodexAuthError('\u001b[31mnot logged in\u001b[0m\n')).toBe('not logged in')
  })

  it('scans newline-heavy output without line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const output = `${'startup log\r\n'.repeat(10_000)}please reauthenticate\r\n`

    expect(extractCodexAuthError(output)).toBe('please reauthenticate')

    const usedLineSplit = splitSpy.mock.calls.some(
      ([separator]) =>
        (typeof separator === 'string' && separator === '\n') ||
        (separator instanceof RegExp && separator.source === '\\r?\\n')
    )
    expect(usedLineSplit).toBe(false)
  })
})
