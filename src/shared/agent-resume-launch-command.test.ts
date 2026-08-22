import { describe, expect, it } from 'vitest'
import { buildClaudeResumeLaunchCommand } from './agent-resume-launch-command'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

const SESSION_ID = 'claude-session-1'
const RESUME = ['--resume', SESSION_ID] as const
const providerSession = { key: 'session_id', id: SESSION_ID } as const

const SHELLS: { platform: NodeJS.Platform; shell: AgentStartupShell }[] = [
  { platform: 'linux', shell: 'posix' },
  { platform: 'darwin', shell: 'posix' },
  { platform: 'win32', shell: 'powershell' },
  { platform: 'win32', shell: 'cmd' }
]

/** Independent selector oracle — deliberately NOT the implementation's own
 * predicate, so a regression that shrinks the stripped set cannot also blind
 * this assertion. */
function isSelectorShapedToken(token: string): boolean {
  return (
    ['--resume', '--continue', '-r', '-c'].includes(token) ||
    ['--resume=', '--continue=', '-r=', '-c='].some((prefix) => token.startsWith(prefix))
  )
}

/** Tokenizes a launch command and asserts exactly one identity-bearing resume. */
function expectSingleAuthoritativeResume(command: string, shell: AgentStartupShell): void {
  const tokenized = tokenizeStartupCommand(command, shell)
  expect(tokenized.ok).toBe(true)
  if (!tokenized.ok) {
    return
  }
  const selectors = tokenized.tokens.filter(isSelectorShapedToken)
  expect(selectors).toEqual(['--resume'])
  const index = tokenized.tokens.indexOf('--resume')
  expect(tokenized.tokens[index + 1]).toBe(SESSION_ID)
}

describe('buildClaudeResumeLaunchCommand', () => {
  it.each(SHELLS)('appends the authoritative selector to a plain base ($shell)', ({ shell }) => {
    const command = buildClaudeResumeLaunchCommand('claude', RESUME, shell)
    expectSingleAuthoritativeResume(command, shell)
    expect(command.startsWith('claude ')).toBe(true)
  })

  it.each(SHELLS)('strips a bare persisted --resume picker default ($shell)', ({ shell }) => {
    const base = shell === 'cmd' ? 'claude "--resume"' : "claude '--resume'"
    const command = buildClaudeResumeLaunchCommand(base, RESUME, shell)
    expectSingleAuthoritativeResume(command, shell)
  })

  it.each([
    'claude --resume stale-session',
    'claude --resume=stale-session',
    'claude -r stale-session',
    'claude -r=stale-session',
    'claude --resume= --model sonnet',
    'claude --continue',
    'claude -c',
    'claude --continue=1',
    'claude -c=1',
    'claude --resume stale -r older --continue -c'
  ])('replaces stale selectors in %s', (base) => {
    const command = buildClaudeResumeLaunchCommand(base, RESUME, 'posix')
    expectSingleAuthoritativeResume(command, 'posix')
  })

  it('keeps surviving options when stripping selectors', () => {
    expect(
      buildClaudeResumeLaunchCommand('claude --resume stale --model sonnet', RESUME, 'posix')
    ).toBe(`claude --model sonnet '--resume' '${SESSION_ID}'`)
  })

  it('never mistakes a dash-leading option value for a selector', () => {
    expect(buildClaudeResumeLaunchCommand('claude --model -recent', RESUME, 'posix')).toBe(
      `claude --model -recent '--resume' '${SESSION_ID}'`
    )
    expect(
      buildClaudeResumeLaunchCommand('claude --append-system-prompt -rules-here', RESUME, 'posix')
    ).toBe(`claude --append-system-prompt -rules-here '--resume' '${SESSION_ID}'`)
    expect(buildClaudeResumeLaunchCommand('claude --agent -reviewer', RESUME, 'posix')).toBe(
      `claude --agent -reviewer '--resume' '${SESSION_ID}'`
    )
    expect(buildClaudeResumeLaunchCommand('claude --plugin-url -remote.zip', RESUME, 'posix')).toBe(
      `claude --plugin-url -remote.zip '--resume' '${SESSION_ID}'`
    )
  })

  it('leaves the ambiguous joined -r<id> form alone (degrades to pre-guard behavior)', () => {
    expect(buildClaudeResumeLaunchCommand('claude -rstale-session', RESUME, 'posix')).toBe(
      `claude -rstale-session '--resume' '${SESSION_ID}'`
    )
  })

  it('leaves wrapper commands untouched and appends at the end', () => {
    expect(buildClaudeResumeLaunchCommand('bash -c claude', RESUME, 'posix')).toBe(
      `bash -c claude '--resume' '${SESSION_ID}'`
    )
    expect(buildClaudeResumeLaunchCommand('mise exec -- claude', RESUME, 'posix')).toBe(
      `mise exec -- claude '--resume' '${SESSION_ID}'`
    )
    expect(buildClaudeResumeLaunchCommand('sudo -u dev -- claude', RESUME, 'posix')).toBe(
      `sudo -u dev -- claude '--resume' '${SESSION_ID}'`
    )
  })

  it('strips selectors that follow claude after a wrapper terminator', () => {
    expect(
      buildClaudeResumeLaunchCommand("mise exec -- claude '--resume' stale", RESUME, 'posix')
    ).toBe(`mise exec -- claude '--resume' '${SESSION_ID}'`)
  })

  it('fails open for claude outside command position (wrapper without --)', () => {
    // Why: npx/bunx-style passthrough cannot be told apart from an argument
    // that merely names claude, so the guard defers to append-only behavior.
    expect(buildClaudeResumeLaunchCommand("npx claude '--resume'", RESUME, 'posix')).toBe(
      `npx claude '--resume' '--resume' '${SESSION_ID}'`
    )
  })

  it('never mistakes a claude-suffixed argument for the executable', () => {
    expect(
      buildClaudeResumeLaunchCommand(
        'ssh -i ~/.ssh/claude devbox -- claude --resume OLD',
        RESUME,
        'posix'
      )
    ).toBe(`ssh -i ~/.ssh/claude devbox -- claude '--resume' '${SESSION_ID}'`)
    expect(
      buildClaudeResumeLaunchCommand(
        'mise exec --cd /Users/me/src/claude -- claude --resume OLD',
        RESUME,
        'posix'
      )
    ).toBe(`mise exec --cd /Users/me/src/claude -- claude '--resume' '${SESSION_ID}'`)
    // No claude in command position at all: wrapper flags stay untouched.
    expect(
      buildClaudeResumeLaunchCommand(
        'nix develop /Users/me/src/claude -c claude --resume OLD',
        RESUME,
        'posix'
      )
    ).toBe(`nix develop /Users/me/src/claude -c claude --resume OLD '--resume' '${SESSION_ID}'`)
  })

  it.each(['claude "\\--resume" old', 'claude "\\-r" old', 'claude --model "\\--resume"'])(
    'fails open on a double-quoted backslash the shell keeps literal: %s',
    (base) => {
      expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
        `${base} '--resume' '${SESSION_ID}'`
      )
    }
  )

  it('still strips when a double-quoted backslash is shell-consumed', () => {
    expect(
      buildClaudeResumeLaunchCommand('claude --model "a\\"b" --resume old', RESUME, 'posix')
    ).toBe(`claude --model "a\\"b" '--resume' '${SESSION_ID}'`)
  })

  it.each([
    'claude "--resu\\\nme" --resume stale',
    "claude $'-c' --resume stale",
    "claude $'--resu\\x6de' --resume stale"
  ])('fails open when an escape hides a selector from the tokenizer: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it.each([
    'claude --resume old --append-system-prompt "spend under 5$"',
    'claude --resume old --note x$',
    'claude --resume old --note "a$"'
  ])('still strips when a $ is not an expansion opener: %s', (base) => {
    const command = buildClaudeResumeLaunchCommand(base, RESUME, 'posix')
    expect(command).not.toContain('--resume old')
    expectSingleAuthoritativeResume(command, 'posix')
  })

  it.each(['claude a^" --resume ^"b', 'claude ^"x --resume^" --resume old'])(
    'fails open when a cmd caret escapes a quote: %s',
    (base) => {
      // cmd strips the caret and the child's parser reads a bare quote
      // delimiter, so the tokenizer's word boundaries stop matching argv.
      expect(buildClaudeResumeLaunchCommand(base, RESUME, 'cmd')).toBe(
        `${base} "--resume" "${SESSION_ID}"`
      )
    }
  )

  it.each(['claude --resume (Get-Content id.txt)', 'claude --hook { npm -c run } --resume old'])(
    'fails open on bare powershell evaluation syntax: %s',
    (base) => {
      expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
        `${base} '--resume' '${SESSION_ID}'`
      )
    }
  )

  it.each([
    'claude "-`r" foo --model x',
    'claude "-`u{72}" oldid --resume x',
    'claude -`r foo --model x',
    'claude --resum`e stale --model x'
  ])('fails open on powershell escape sequences, quoted or bare: %s', (base) => {
    // PowerShell expands these in bare arguments too, so the tokenizer's
    // token value is not what argv receives.
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on a token-leading powershell backtick before whitespace', () => {
    // PowerShell drops the backtick AND the whitespace, emitting no token,
    // so the tokenizer's extra token would shift the locator.
    const base = 'claude --resume ` \t"q"'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on the powershell stop-parsing token', () => {
    // After a bare --%, PowerShell hands the rest of the line to the child
    // literally, so an appended quoted selector would arrive as literal bytes.
    const base = 'claude --% --resume stale --model sonnet'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('still strips when --% is quoted or on cmd, where it is an ordinary token', () => {
    expect(
      buildClaudeResumeLaunchCommand('claude "--%" --resume stale', RESUME, 'powershell')
    ).toBe(`claude "--%" '--resume' '${SESSION_ID}'`)
    expect(buildClaudeResumeLaunchCommand('claude --% --resume stale', RESUME, 'cmd')).toBe(
      `claude --% "--resume" "${SESSION_ID}"`
    )
  })

  it('still strips with parens safely inside quotes on powershell', () => {
    expect(
      buildClaudeResumeLaunchCommand(
        'claude --allowedTools "Bash(git:*)" --resume old',
        RESUME,
        'powershell'
      )
    ).toBe(`claude --allowedTools "Bash(git:*)" '--resume' '${SESSION_ID}'`)
  })

  it.each([
    'claude "--add-dir" "C:\\a\\" "--" "--out" "D:\\x\\"',
    'claude --add-dir "C:\\repo\\" --resume old'
  ])('fails open when a cmd backslash run makes a quote literal: %s', (base) => {
    // An odd run of backslashes makes the quote a literal byte to the child's
    // CommandLineToArgvW parser, so tokenizer boundaries stop matching argv.
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'cmd')).toBe(
      `${base} "--resume" "${SESSION_ID}"`
    )
  })

  it.each([
    'claude --add-dir "C:\\Users\\me\\repo" --resume old',
    'claude --add-dir "C:\\Program Files (x86)\\x" --resume old'
  ])('still strips for ordinary quoted windows paths: %s', (base) => {
    const command = buildClaudeResumeLaunchCommand(base, RESUME, 'cmd')
    expect(command).not.toContain('--resume old')
    expectSingleAuthoritativeResume(command, 'cmd')
  })

  it('fails open when a cmd caret escapes a real argument separator', () => {
    // cmd strips ^ before the child re-splits on the bare space, so the
    // tokenizer's merged token would drop the user's second argument.
    const base = 'claude --resume a^ b --model x'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'cmd')).toBe(
      `${base} "--resume" "${SESSION_ID}"`
    )
  })

  it.each([
    ['claude --resume old \\', 'posix' as const],
    ['claude --resume old `', 'powershell' as const],
    ['claude --resume old ^', 'cmd' as const]
  ])('fails open on a trailing unpaired escape: %s', (base, shell) => {
    // A dangling escape would swallow the separator before the appended
    // selector, so claude would receive no exact --resume at all.
    const quoted = shell === 'cmd' ? `"--resume" "${SESSION_ID}"` : `'--resume' '${SESSION_ID}'`
    expect(buildClaudeResumeLaunchCommand(base, RESUME, shell)).toBe(`${base} ${quoted}`)
  })

  it('fails open on a windows escaped line continuation', () => {
    const powershellBase = 'claude --resume stale `\n--resume hidden'
    expect(buildClaudeResumeLaunchCommand(powershellBase, RESUME, 'powershell')).toBe(
      `${powershellBase} '--resume' '${SESSION_ID}'`
    )
    const cmdBase = 'claude --resume stale ^\n--resume hidden'
    expect(buildClaudeResumeLaunchCommand(cmdBase, RESUME, 'cmd')).toBe(
      `${cmdBase} "--resume" "${SESSION_ID}"`
    )
  })

  it('fails open on a posix line continuation hiding a selector', () => {
    const base = 'claude --model x \\\n--resume old'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on escape characters the windows shells keep literal', () => {
    // cmd keeps ^ literal inside double quotes; PowerShell keeps ` literal
    // inside single quotes, so these tokens are not really selectors.
    expect(buildClaudeResumeLaunchCommand('claude "-^-resume" old', RESUME, 'cmd')).toBe(
      `claude "-^-resume" old "--resume" "${SESSION_ID}"`
    )
    expect(buildClaudeResumeLaunchCommand("claude '-`-resume' old", RESUME, 'powershell')).toBe(
      `claude '-\`-resume' old '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on an unclosed expansion opened before claude', () => {
    const base = '$(x; npx -- claude --resume stale)'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open when the executable token itself is unmodelable', () => {
    // cmd has no single-quote syntax, so 'claude' is not the claude executable.
    expect(buildClaudeResumeLaunchCommand("'claude' --resume old", RESUME, 'cmd')).toBe(
      `'claude' --resume old "--resume" "${SESSION_ID}"`
    )
  })

  it.each(['cmd', 'powershell'] as const)(
    'fails open on a posix-style assignment prefix under %s',
    (shell) => {
      // NAME=value prefixes are posix-only syntax; on Windows shells that
      // token is a bogus executable, so nothing may be spliced.
      const base = "FOO='bar' claude --resume old"
      const quoted = shell === 'cmd' ? `"--resume" "${SESSION_ID}"` : `'--resume' '${SESSION_ID}'`
      expect(buildClaudeResumeLaunchCommand(base, RESUME, shell)).toBe(`${base} ${quoted}`)
    }
  )

  it('preserves an env-assignment or path prefix byte for byte', () => {
    expect(
      buildClaudeResumeLaunchCommand('FOO="$HOME/x" ~/bin/claude \'--resume\'', RESUME, 'posix')
    ).toBe(`FOO="$HOME/x" ~/bin/claude '--resume' '${SESSION_ID}'`)
  })

  it('recognizes Windows claude executable spellings', () => {
    expect(buildClaudeResumeLaunchCommand('C:\\tools\\claude.CMD "--resume"', RESUME, 'cmd')).toBe(
      `C:\\tools\\claude.CMD "--resume" "${SESSION_ID}"`
    )
  })

  it("inserts the selector before claude's own -- terminator", () => {
    expect(
      buildClaudeResumeLaunchCommand('claude --resume stale -- positional', RESUME, 'posix')
    ).toBe(`claude '--resume' '${SESSION_ID}' -- positional`)
  })

  it('fails open when the base cannot be tokenized', () => {
    expect(buildClaudeResumeLaunchCommand('claude "unterminated', RESUME, 'posix')).toBe(
      `claude "unterminated '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open when no claude executable token exists', () => {
    expect(buildClaudeResumeLaunchCommand('my-agent-wrapper --resume', RESUME, 'posix')).toBe(
      `my-agent-wrapper --resume '--resume' '${SESSION_ID}'`
    )
  })

  it.each([
    'claude -c && echo done',
    'claude --resume stale; echo hi',
    'claude --resume stale;echo hi',
    'claude -c | tee /tmp/log',
    'claude --resume stale 2>/tmp/x.log',
    'claude --resume stale\n--verbose',
    'claude --resume stale # note'
  ])('fails open when the base chains shell syntax after claude: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it.each([
    'claude --resume old "y"; echo hi',
    "claude --resume old 'y'; echo hi",
    'claude --resume old --model "sonnet"&&echo hi',
    'claude --resume old "y"| tee /tmp/x',
    'claude --resume old \\"; echo hi'
  ])('fails open when shell syntax hides behind partial quoting: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on escape-adjacent operators in windows shells', () => {
    const powershellBase = 'claude --resume old `x; echo hi'
    expect(buildClaudeResumeLaunchCommand(powershellBase, RESUME, 'powershell')).toBe(
      `${powershellBase} '--resume' '${SESSION_ID}'`
    )
    const cmdBase = 'claude --resume old ^x& echo hi'
    expect(buildClaudeResumeLaunchCommand(cmdBase, RESUME, 'cmd')).toBe(
      `${cmdBase} "--resume" "${SESSION_ID}"`
    )
  })

  it.each([
    'claude --resume $(cat sid.txt)',
    'claude --resume=$(cat sid.txt)',
    'claude --resume `cat sid.txt`',
    'claude --resume ${SID:-a b}'
  ])('fails open on unquoted multi-token shell expansions: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it.each([
    'claude --resume "`cat "a b"`"',
    'claude --model "$(pick "x -c y")"',
    'claude --model "$(f "x --resume y")"',
    'claude --resume "$(cat "$HOME/My Sessions/id")"'
  ])('fails open on expansions nested inside double quotes: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on a powershell double-quoted subexpression', () => {
    const base = 'claude --model "$(pick "x -c y")"'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on a powershell subexpression locator', () => {
    const base = 'claude --resume $(Get-Content sid.txt)'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('never walks the separator backoff into an escaped-space token', () => {
    expect(
      buildClaudeResumeLaunchCommand(
        'claude --append-system-prompt Be\\ nice\\  --resume OLD',
        RESUME,
        'posix'
      )
    ).toBe(`claude --append-system-prompt Be\\ nice\\  '--resume' '${SESSION_ID}'`)
  })

  it('fails open when cmd operators hide in single quotes', () => {
    // cmd.exe has no single-quote syntax, so '&' is a live command separator.
    expect(buildClaudeResumeLaunchCommand("claude '&' --resume=old-session", RESUME, 'cmd')).toBe(
      `claude '&' --resume=old-session "--resume" "${SESSION_ID}"`
    )
  })

  it('fails open on cmd single-quoted literals that merely look like selectors', () => {
    // cmd passes the quotes through, so these are junk positionals for
    // claude, not real selectors or terminators.
    expect(buildClaudeResumeLaunchCommand("claude '--resume' old", RESUME, 'cmd')).toBe(
      `claude '--resume' old "--resume" "${SESSION_ID}"`
    )
    expect(buildClaudeResumeLaunchCommand("claude '--' --resume old", RESUME, 'cmd')).toBe(
      `claude '--' --resume old "--resume" "${SESSION_ID}"`
    )
  })

  it('still strips next to a caret-escaped literal ampersand on cmd', () => {
    // ^& is an inactive, literal & in cmd, so the guard may keep working.
    expect(buildClaudeResumeLaunchCommand('claude --resume old ^&', RESUME, 'cmd')).toBe(
      `claude ^& "--resume" "${SESSION_ID}"`
    )
  })

  it('still strips when operators are safely quoted', () => {
    expect(
      buildClaudeResumeLaunchCommand(
        "claude --append-system-prompt 'use && wisely' --resume stale",
        RESUME,
        'posix'
      )
    ).toBe(`claude --append-system-prompt 'use && wisely' '--resume' '${SESSION_ID}'`)
  })

  it('recognizes claude behind the PowerShell call operator', () => {
    expect(buildClaudeResumeLaunchCommand("& claude '--resume'", RESUME, 'powershell')).toBe(
      `& claude '--resume' '${SESSION_ID}'`
    )
    expect(
      buildClaudeResumeLaunchCommand(
        "& 'C:\\Program Files\\claude\\claude.exe' --resume old",
        RESUME,
        'powershell'
      )
    ).toBe(`& 'C:\\Program Files\\claude\\claude.exe' '--resume' '${SESSION_ID}'`)
  })
})

describe('buildAgentResumeStartupPlan claude selector guard', () => {
  it.each(SHELLS)(
    'emits one identity-bearing resume for a persisted bare selector ($platform/$shell)',
    ({ platform, shell }) => {
      const initial = buildAgentStartupPlan({
        agent: 'claude',
        prompt: '',
        cmdOverrides: {},
        agentArgs: '--resume',
        platform,
        shell,
        allowEmptyPromptLaunch: true
      })
      expect(initial).not.toBeNull()
      const restored = buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession,
        cmdOverrides: {},
        agentArgs: initial?.launchConfig.agentArgs,
        agentCommand: initial?.launchConfig.agentCommand,
        platform,
        shell
      })
      expect(restored).not.toBeNull()
      expectSingleAuthoritativeResume(restored?.launchCommand ?? '', shell)
    }
  )

  it('emits one identity-bearing resume when only default args carry a stale id', () => {
    const restored = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      agentArgs: '--resume stale-session --model sonnet',
      platform: 'linux'
    })
    expect(restored?.launchCommand).toBe(`claude '--model' 'sonnet' '--resume' '${SESSION_ID}'`)
  })

  it('still launches exotic custom commands that the tokenizer rejects', () => {
    const restored = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      agentCommand: 'claude --model $(cat ~/.claude-model) "unterminated',
      platform: 'darwin'
    })
    expect(restored).not.toBeNull()
    expect(restored?.launchCommand.endsWith(`'--resume' '${SESSION_ID}'`)).toBe(true)
  })

  it('does not change other agents', () => {
    const restored = buildAgentResumeStartupPlan({
      agent: 'gemini',
      providerSession,
      cmdOverrides: {},
      agentArgs: '--resume',
      platform: 'linux'
    })
    expect(restored?.launchCommand).toBe(`gemini '--resume' '--resume' '${SESSION_ID}'`)
  })

  it('persists the original base command unchanged', () => {
    const restored = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession,
      cmdOverrides: {},
      agentCommand: "claude '--resume'",
      platform: 'linux'
    })
    expect(restored?.launchConfig.agentCommand).toBe("claude '--resume'")
  })
})
