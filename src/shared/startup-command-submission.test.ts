import { describe, expect, it } from 'vitest'
import { buildStartupCommandSubmission } from './startup-command-submission'

describe('buildStartupCommandSubmission', () => {
  it('appends the submit byte to a single-line command unchanged', () => {
    expect(
      buildStartupCommandSubmission('claude', { submit: '\n', bracketedPasteSafe: true })
    ).toBe('claude\n')
    expect(
      buildStartupCommandSubmission('claude', { submit: '\r', bracketedPasteSafe: true })
    ).toBe('claude\r')
  })

  it('preserves a caller-supplied trailing submit byte on single-line commands', () => {
    expect(
      buildStartupCommandSubmission('claude\n', { submit: '\r', bracketedPasteSafe: true })
    ).toBe('claude\n')
  })

  it('treats a CRLF-terminated single-line command as single-line', () => {
    expect(
      buildStartupCommandSubmission('claude\r\n', { submit: '\r', bracketedPasteSafe: true })
    ).toBe('claude\r\n')
  })

  it('wraps a multiline command in bracketed paste with a trailing submit byte', () => {
    const command = "claude 'first\nsecond'"
    expect(buildStartupCommandSubmission(command, { submit: '\n', bracketedPasteSafe: true })).toBe(
      `\x1b[200~${command}\x1b[201~\n`
    )
  })

  it('strips a trailing submit byte before bracket-wrapping the multiline body', () => {
    const body = "claude 'first\nsecond'"
    expect(
      buildStartupCommandSubmission(`${body}\n`, { submit: '\r', bracketedPasteSafe: true })
    ).toBe(`\x1b[200~${body}\x1b[201~\r`)
  })

  it('keeps the raw path for multiline commands when bracketed paste is unsafe', () => {
    const command = 'echo one\necho two'
    expect(
      buildStartupCommandSubmission(command, { submit: '\n', bracketedPasteSafe: false })
    ).toBe(`${command}\n`)
  })
})
