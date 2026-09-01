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

describe('quoteStartupArg', () => {
  describe('cmd', () => {
    it('passes the neutral metacharacters & | < > ( ) through unmodified inside quotes', () => {
      // Regression: the old quoter caret-escaped inside double quotes, where a
      // caret is literal, so "C:\Foo & Bar" reached the program as C:\Foo ^& Bar.
      expect(quoteStartupArg('C:\\Foo & Bar', 'cmd')).toBe('"C:\\Foo & Bar"')
      expect(quoteStartupArg('a|b<c>d(e)f', 'cmd')).toBe('"a|b<c>d(e)f"')
    })

    it('keeps Windows backslashes literal', () => {
      expect(quoteStartupArg('C:\\Users\\me\\bin\\codex.exe', 'cmd')).toBe(
        '"C:\\Users\\me\\bin\\codex.exe"'
      )
    })

    it('caret-escapes once an embedded quote would break out of the quoted run', () => {
      // Regression (command execution from prompt text): the legacy built-in
      // planners quote raw prompts with no cmd_metachar guard, so `"` must not
      // be allowed to close the quote and expose `&` as a command separator.
      expect(quoteStartupArg('fix the "foo bug & del /q C:\\tmp\\*', 'cmd')).toBe(
        '"fix the ^"foo bug ^& del /q C:\\tmp\\*"'
      )
    })

    it('caret-escapes percent and bang, which quotes never suppress', () => {
      expect(quoteStartupArg('%USERPROFILE%\\bin', 'cmd')).toBe('"^%USERPROFILE^%\\bin"')
      expect(quoteStartupArg('a & !VAR!', 'cmd')).toBe('"a ^& ^!VAR^!"')
    })

    it('leaves a lone caret literal instead of doubling it', () => {
      expect(quoteStartupArg('C:\\Foo^Bar', 'cmd')).toBe('"C:\\Foo^Bar"')
    })
  })

  describe('powershell', () => {
    it('doubles ASCII single quotes', () => {
      expect(quoteStartupArg("it's", 'powershell')).toBe("'it''s'")
    })

    it('doubles the U+2018-U+201B delimiter class PowerShell also treats as quotes', () => {
      expect(quoteStartupArg('a‘b', 'powershell')).toBe("'a‘‘b'")
      expect(quoteStartupArg('a’b', 'powershell')).toBe("'a’’b'")
      expect(quoteStartupArg('a‚b', 'powershell')).toBe("'a‚‚b'")
      expect(quoteStartupArg('a‛b', 'powershell')).toBe("'a‛‛b'")
    })

    it('keeps backslashes and other metacharacters literal', () => {
      expect(quoteStartupArg('C:\\Users\\me', 'powershell')).toBe("'C:\\Users\\me'")
      expect(quoteStartupArg('$env:PATH;&|', 'powershell')).toBe("'$env:PATH;&|'")
    })
  })

  describe('posix', () => {
    it('single-quotes with the standard quote-splice escape', () => {
      expect(quoteStartupArg("it's", 'posix')).toBe(`'it'"'"'s'`)
      expect(quoteStartupArg('a $VAR `cmd` "x"', 'posix')).toBe(`'a $VAR \`cmd\` "x"'`)
    })
  })
})

describe('buildShellCommandFromArgv', () => {
  it('quotes each element exactly once per target shell', () => {
    expect(buildShellCommandFromArgv(['/opt/my tools/codex', '--model', 'x y'], 'posix')).toBe(
      `'/opt/my tools/codex' '--model' 'x y'`
    )
    expect(buildShellCommandFromArgv(['codex', '--flag'], 'powershell')).toBe(`& 'codex' '--flag'`)
    expect(buildShellCommandFromArgv(['C:\\a & b\\codex.exe', '--flag'], 'cmd')).toBe(
      '"C:\\a & b\\codex.exe" "--flag"'
    )
  })

  // Regression: legacy agentCmdOverrides were raw shell text before the resolver
  // existed, so quoting `~/…` / `$HOME/…` whole named a nonexistent executable.
  it('leaves a ~ or $VAR head in the executable expandable on posix', () => {
    expect(buildShellCommandFromArgv(['~/.local/bin/claude', '--x'], 'posix')).toBe(
      `~/'.local/bin/claude' '--x'`
    )
    expect(buildShellCommandFromArgv(['$HOME/.bun/bin/codex'], 'posix')).toBe(
      `"$HOME"'/.bun/bin/codex'`
    )
    expect(buildShellCommandFromArgv(['${NVM_BIN}/claude'], 'posix')).toBe(`"\${NVM_BIN}"'/claude'`)
    expect(buildShellCommandFromArgv(['~'], 'posix')).toBe('~')
  })

  it('keeps the expandable head out of every non-executable position', () => {
    expect(buildShellCommandFromArgv(['claude', '$HOME/x'], 'posix')).toBe(`'claude' '$HOME/x'`)
  })

  it('quotes an executable whose tail is not shell-inert', () => {
    for (const value of ['~/my bin/agent', '$(id)', '~/`id`', '$HOME/*/claude', '~/a;b']) {
      expect(buildShellCommandFromArgv([value], 'posix')).toBe(quoteStartupArg(value, 'posix'))
    }
  })

  it('never defers expansion on Windows shells', () => {
    expect(buildShellCommandFromArgv(['~/bin/agent'], 'powershell')).toBe(`& '~/bin/agent'`)
    expect(buildShellCommandFromArgv(['$HOME/bin/agent'], 'cmd')).toBe('"$HOME/bin/agent"')
  })
})
