import { describe, expect, it } from 'vitest'
import { buildStartupCommandSubmission } from './startup-command-submission'

describe('buildStartupCommandSubmission', () => {
  it('replaces a caller-supplied trailing terminator with CR', () => {
    for (const command of ['claude\n', 'claude\r', 'claude\r\n']) {
      expect(buildStartupCommandSubmission(command, { bracketedPasteSafe: true })).toBe('claude\r')
    }
  })

  it('wraps a multiline command in bracketed paste with a trailing submit byte', () => {
    const command = "claude 'first\nsecond'"
    expect(buildStartupCommandSubmission(command, { bracketedPasteSafe: true })).toBe(
      `\x1b[200~${command}\x1b[201~\r`
    )
  })

  it('strips a trailing submit byte before bracket-wrapping the multiline body', () => {
    const body = "claude 'first\nsecond'"
    expect(buildStartupCommandSubmission(`${body}\n`, { bracketedPasteSafe: true })).toBe(
      `\x1b[200~${body}\x1b[201~\r`
    )
  })

  // Interior LF is remappable Ctrl+J too; every raw line must submit with CR (#23250).
  it('submits every line of a raw multiline command with CR', () => {
    for (const command of ['echo one\necho two', 'echo one\r\necho two', 'echo one\recho two']) {
      expect(buildStartupCommandSubmission(command, { bracketedPasteSafe: false })).toBe(
        'echo one\recho two\r'
      )
    }
  })
})
