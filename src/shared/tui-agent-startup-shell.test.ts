import { describe, expect, it } from 'vitest'
import {
  buildShellCommandFromArgv,
  clearEnvCommand,
  commandSeparator,
  isPosixStartupShell,
  quoteStartupArg,
  tokenizeStartupCommand
} from './tui-agent-startup-shell'
import { buildAgentDraftLaunchPlan } from './tui-agent-startup'

function expectSpansCoverTokens(source: string, shell: 'powershell' | 'cmd'): string[] {
  const result = tokenizeStartupCommand(source, shell)
  expect(result.ok).toBe(true)
  if (!result.ok) {
    return []
  }
  expect(result.spans).toHaveLength(result.tokens.length)
  let previousEnd = 0
  for (const [index, { start, end }] of result.spans.entries()) {
    expect(start).toBeGreaterThanOrEqual(previousEnd)
    expect(end).toBeGreaterThan(start)
    // Every raw span must re-tokenize to exactly its own token.
    const slice = tokenizeStartupCommand(source.slice(start, end), shell)
    expect(slice.ok && slice.tokens).toEqual([result.tokens[index]])
    previousEnd = end
  }
  return result.spans.map(({ start, end }) => source.slice(start, end))
}

describe('tokenizeStartupCommand spans (windows shells)', () => {
  it('covers plain and quoted tokens on powershell', () => {
    const source = "claude --msg 'hello world'"
    const result = tokenizeStartupCommand(source, 'powershell')
    expect(result).toEqual({
      ok: true,
      tokens: ['claude', '--msg', 'hello world'],
      spans: [
        { start: 0, end: 6, divergesFromShell: false },
        { start: 7, end: 12, divergesFromShell: false },
        { start: 13, end: 26, divergesFromShell: false }
      ]
    })
  })

  it('starts a span at a token-leading escape character', () => {
    expect(expectSpansCoverTokens('claude ^&literal next', 'cmd')).toEqual([
      'claude',
      '^&literal',
      'next'
    ])
    expect(expectSpansCoverTokens('claude `x tail', 'powershell')).toEqual(['claude', '`x', 'tail'])
  })

  it('spans a powershell doubled-quote token as one raw range', () => {
    expect(expectSpansCoverTokens("claude 'a''b' end", 'powershell')).toEqual([
      'claude',
      "'a''b'",
      'end'
    ])
  })

  it('spans a token opened by a quote at end of input', () => {
    expect(expectSpansCoverTokens('claude ""', 'cmd')).toEqual(['claude', '""'])
  })
})

describe('one Unix startup dialect', () => {
  it('clears variables with a self-contained branch, not a per-shell builtin', () => {
    // Why not `unset`/`set -e` alone, and why not a wrapper-defined helper:
    // Orca only wraps zsh/bash/fish, so an `sh`/`dash`/`ksh` login shell — and
    // any shell the user pastes copied text into — would not have the helper.
    // startup-shell-portability.live-shell.test.ts proves this form works in
    // real sh/bash/zsh/dash/ksh/fish.
    expect(clearEnvCommand('CODEX_HOME', 'posix')).toBe(
      `command test -n "$fish_pid" && set --erase -g CODEX_HOME; command test -z "$fish_pid" && unset CODEX_HOME; true`
    )
    expect(clearEnvCommand(['A', 'B'], 'posix')).toBe(
      `command test -n "$fish_pid" && set --erase -g A B; command test -z "$fish_pid" && unset A B; true`
    )
    expect(clearEnvCommand('CODEX_HOME', 'cmd')).toBe('set "CODEX_HOME="')
    expect(clearEnvCommand('CODEX_HOME', 'powershell')).toBe(
      'Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue'
    )
  })

  it.each([
    'FOO; rm -rf /tmp/x',
    'FOO BAR',
    '',
    '1LEADING_DIGIT',
    'has-dash',
    '$FOO',
    'PATH\nHOME'
  ])('refuses %j as an environment variable name', (bad) => {
    // Why: the name is interpolated straight into a shell line. Anything but an
    // identifier is a command injection, and in fish `set --erase -g` would
    // really delete whatever it names — PATH or HOME included.
    expect(() => clearEnvCommand(bad, 'posix')).toThrow(/not an environment variable name/)
    expect(() => clearEnvCommand(['OK', bad], 'posix')).toThrow(/not an environment variable name/)
  })

  it('quotes so fish reads back the same bytes sh does', () => {
    // fish single quotes are NOT literal — `\\` and `\'` are escapes inside them —
    // so the sh `'\''` idiom would halve these backslashes when fish read them,
    // and a trailing backslash would be a hard syntax error.
    expect(quoteStartupArg("it's", 'posix')).toBe(`'it'"'"'s'`)
    expect(quoteStartupArg(String.raw`\\server\share`, 'posix')).toBe(
      `"\\\\""\\\\"'server'"\\\\"'share'`
    )
    expect(quoteStartupArg('ends\\', 'posix')).toBe(`'ends'"\\\\"`)
    expect(quoteStartupArg('', 'posix')).toBe(`''`)
  })

  it('keeps the sh-family grammar claims that do hold for fish', () => {
    expect(commandSeparator('posix')).toBe('; ')
    expect(isPosixStartupShell('posix')).toBe(true)
    expect(isPosixStartupShell('powershell')).toBe(false)
    expect(buildShellCommandFromArgv(['codex', 'resume', 'a b'], 'posix')).toBe(
      `'codex' 'resume' 'a b'`
    )
  })

  it('round-trips an adversarial argument through quote then tokenize', () => {
    for (const value of [
      String.raw`use \d+ and \\server\share`,
      "it's mine",
      'ends\\',
      'a "b" c',
      '$PATH *.ts'
    ]) {
      const tokenized = tokenizeStartupCommand(quoteStartupArg(value, 'posix'), 'posix')
      expect(tokenized.ok && tokenized.tokens).toEqual([value])
    }
  })

  it('clears an agent draft prefill variable with the portable teardown', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'pi',
      draft: 'hello',
      cmdOverrides: {},
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe(
      `pi; command test -n "$fish_pid" && set --erase -g ORCA_PI_PREFILL; command test -z "$fish_pid" && unset ORCA_PI_PREFILL; true`
    )
    expect(plan?.env?.ORCA_PI_PREFILL).toBe('hello')
  })
})
