import { describe, expect, it } from 'vitest'
import { buildClaudeResumeLaunchCommand } from './agent-resume-launch-command'

const SESSION_ID = 'claude-session-1'
const RESUME = ['--resume', SESSION_ID] as const

describe('buildClaudeResumeLaunchCommand', () => {
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
