import { describe, expect, it } from 'vitest'
import { tokenizeCustomCommandTemplate } from './commit-message-prompt'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

describe('startup command validation before shell execution', () => {
  it.each(['agy\nHOME=/other agy', 'agy\nsudo -u other agy'])(
    'rejects a newline launching agy under another authority: %j',
    (source) => {
      expect(tokenizeStartupCommand(source, 'posix', { requireSingleCommand: true }).ok).toBe(false)
    }
  )

  describe.each<AgentStartupShell>(['posix', 'powershell', 'cmd'])('%s separators', (shell) => {
    it.each(['\n', '\r', '\r\n'])(
      'rejects an unquoted line separator anywhere in the command: %j',
      (separator) => {
        for (const source of [`${separator}agy`, `agy${separator}`, `agy${separator}other`]) {
          expect(tokenizeStartupCommand(source, shell, { requireSingleCommand: true }).ok).toBe(
            false
          )
        }
      }
    )

    it.each(['', ' \t '])('rejects a command with no executable: %j', (source) => {
      expect(tokenizeStartupCommand(source, shell, { requireSingleCommand: true }).ok).toBe(false)
    })

    it.each(['agy "unclosed', "agy 'unclosed"])('rejects an unclosed quote: %j', (source) => {
      expect(tokenizeStartupCommand(source, shell, { requireSingleCommand: true }).ok).toBe(false)
    })

    it('keeps existing template parsing when single-command validation is absent', () => {
      const result = tokenizeStartupCommand('\nagy\r\nother\r', shell)
      expect(result.ok && result.tokens).toEqual(['agy', 'other'])
      expect(tokenizeStartupCommand('', shell)).toEqual({ ok: true, tokens: [], spans: [] })
    })
  })

  describe.each<AgentStartupShell>(['posix', 'powershell'])('%s quoted arguments', (shell) => {
    it.each([
      ["agy --prompt 'first\nsecond'", 'first\nsecond'],
      ['agy --prompt "first\nsecond"', 'first\nsecond'],
      ["agy --prompt 'first\r\nsecond'", 'first\r\nsecond'],
      ['agy --prompt "first\rsecond"', 'first\rsecond']
    ])('preserves a quoted multiline prompt: %j', (source, prompt) => {
      const result = tokenizeStartupCommand(source, shell, { requireSingleCommand: true })
      expect(result.ok && result.tokens).toEqual(['agy', '--prompt', prompt])
      expect(result.ok && result.spans.every((span) => !span.divergesFromShell)).toBe(true)
    })
  })

  it('preserves POSIX escaped quotes without closing the prompt prematurely', () => {
    const result = tokenizeStartupCommand('agy --prompt "say \\"hi\\"\nthen stop"', 'posix', {
      requireSingleCommand: true
    })
    expect(result.ok && result.tokens).toEqual(['agy', '--prompt', 'say "hi"\nthen stop'])
  })

  it.each([
    ['posix', 'agy\\\n--prompt test'],
    ['posix', 'agy\\\r--prompt test'],
    ['posix', 'agy\\\r\n--prompt test'],
    ['posix', 'agy --prompt "first\\\nsecond"'],
    ['posix', 'agy --prompt "first\\\rsecond"'],
    ['powershell', 'agy`\n--prompt test'],
    ['powershell', 'agy`\r\n--prompt test'],
    ['cmd', 'agy^\n--prompt test'],
    ['cmd', 'agy^\r\n--prompt test']
  ] as const)('rejects an unmodeled %s escaped line continuation: %j', (shell, source) => {
    expect(tokenizeStartupCommand(source, shell, { requireSingleCommand: true }).ok).toBe(false)
  })

  it('keeps a backslash and newline literal inside POSIX single quotes', () => {
    const result = tokenizeStartupCommand("agy --prompt 'first\\\nsecond'", 'posix', {
      requireSingleCommand: true
    })
    expect(result.ok && result.tokens).toEqual(['agy', '--prompt', 'first\\\nsecond'])
  })

  it('rejects the separator after an escaped quote in an unquoted argument', () => {
    expect(
      tokenizeStartupCommand('agy --prompt quoted\\"\nHOME=/other agy', 'posix', {
        requireSingleCommand: true
      }).ok
    ).toBe(false)
  })

  it('lets the shared POSIX template lexer opt in without changing its default behavior', () => {
    expect(
      tokenizeCustomCommandTemplate('agy\nHOME=/other agy', 'escape', {
        requireSingleCommand: true
      }).ok
    ).toBe(false)
    const result = tokenizeCustomCommandTemplate('agy\nHOME=/other agy')
    expect(result.ok && result.tokens).toEqual(['agy', 'HOME=/other', 'agy'])
  })
})
