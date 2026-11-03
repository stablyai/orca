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

/** Use an independent selector oracle so shrinking the stripped set cannot also blind the assertion. */
function isResumeSelectorToken(token: string): boolean {
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
  const selectors = tokenized.tokens.filter(isResumeSelectorToken)
  expect(selectors).toEqual(['--resume'])
  const index = tokenized.tokens.indexOf('--resume')
  expect(tokenized.tokens[index + 1]).toBe(SESSION_ID)
}

describe('buildClaudeResumeLaunchCommand', () => {
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

  it('strips selectors that follow claude after a wrapper terminator', () => {
    expect(
      buildClaudeResumeLaunchCommand("mise exec -- claude '--resume' stale", RESUME, 'posix')
    ).toBe(`mise exec -- claude '--resume' '${SESSION_ID}'`)
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
    'claude "-`r" foo --model x',
    'claude "-`u{72}" oldid --resume x',
    'claude -`r foo --model x',
    'claude --resum`e stale --model x'
  ])('fails open on powershell escape sequences, quoted or bare: %s', (base) => {
    // PowerShell expands bare escape sequences too; token values no longer match argv.
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it('fails open on the powershell stop-parsing token', () => {
    // After --%, appended quotes reach the child literally.
    const base = 'claude --% --resume stale --model sonnet'
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'powershell')).toBe(
      `${base} '--resume' '${SESSION_ID}'`
    )
  })

  it.each([
    ['claude --resume old \\', 'posix' as const],
    ['claude --resume old `', 'powershell' as const],
    ['claude --resume old ^', 'cmd' as const]
  ])('fails open on a trailing unpaired escape: %s', (base, shell) => {
    // A dangling escape can swallow the appended selector's separator.
    const quoted = shell === 'cmd' ? `"--resume" "${SESSION_ID}"` : `'--resume' '${SESSION_ID}'`
    expect(buildClaudeResumeLaunchCommand(base, RESUME, shell)).toBe(`${base} ${quoted}`)
  })

  it('preserves an env-assignment or path prefix byte for byte', () => {
    expect(
      buildClaudeResumeLaunchCommand('FOO="$HOME/x" ~/bin/claude \'--resume\'', RESUME, 'posix')
    ).toBe(`FOO="$HOME/x" ~/bin/claude '--resume' '${SESSION_ID}'`)
  })

  it("inserts the selector before claude's own -- terminator", () => {
    expect(
      buildClaudeResumeLaunchCommand('claude --resume stale -- positional', RESUME, 'posix')
    ).toBe(`claude '--resume' '${SESSION_ID}' -- positional`)
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
    'claude --resume $(cat sid.txt)',
    'claude --resume=$(cat sid.txt)',
    'claude --resume `cat sid.txt`',
    'claude --resume ${SID:-a b}'
  ])('fails open on unquoted multi-token shell expansions: %s', (base) => {
    expect(buildClaudeResumeLaunchCommand(base, RESUME, 'posix')).toBe(
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

  it('fails open on cmd single-quoted literals that merely look like selectors', () => {
    // cmd passes single quotes through as junk positional bytes, not selectors/terminators.
    expect(buildClaudeResumeLaunchCommand("claude '--resume' old", RESUME, 'cmd')).toBe(
      `claude '--resume' old "--resume" "${SESSION_ID}"`
    )
    expect(buildClaudeResumeLaunchCommand("claude '--' --resume old", RESUME, 'cmd')).toBe(
      `claude '--' --resume old "--resume" "${SESSION_ID}"`
    )
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

describe('buildAgentResumeStartupPlan claude effort', () => {
  it.each(SHELLS)(
    "resumes at the session's effort after a stale launch flag ($platform/$shell)",
    ({ platform, shell }) => {
      const session = { ...providerSession, effort: 'max' }
      const restored = buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: session,
        cmdOverrides: {},
        agentArgs: '--effort low',
        platform,
        shell
      })
      const command = restored?.launchCommand ?? ''
      const tokens = tokenizeStartupCommand(command, shell)
      // Claude keeps the last --effort it parses.
      expect(tokens.ok && tokens.tokens.slice(-6)).toEqual([
        '--effort',
        'low',
        '--effort',
        'max',
        ...RESUME
      ])
      // The saved launch recipe stays the user's own.
      expect(restored?.launchConfig.agentArgs).toBe('--effort low')
    }
  )
})
