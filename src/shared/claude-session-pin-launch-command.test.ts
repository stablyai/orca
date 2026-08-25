import { describe, expect, it } from 'vitest'

import { pinClaudeLaunchSessionId } from './claude-session-pin-launch-command'

const SESSION = '0192a4b1-1111-4111-8111-aaaaaaaaaaaa'

describe('pinClaudeLaunchSessionId', () => {
  it('pins a bare launch', () => {
    expect(pinClaudeLaunchSessionId('claude', SESSION, 'posix')).toBe(
      `claude --session-id ${SESSION}`
    )
  })

  it('pins path-qualified and Windows executables', () => {
    expect(pinClaudeLaunchSessionId('/usr/local/bin/claude --model opus', SESSION, 'posix')).toBe(
      `/usr/local/bin/claude --session-id ${SESSION} --model opus`
    )
    expect(pinClaudeLaunchSessionId('claude.cmd', SESSION, 'cmd')).toBe(
      `claude.cmd --session-id ${SESSION}`
    )
    expect(pinClaudeLaunchSessionId('& claude', SESSION, 'powershell')).toBe(
      `& claude --session-id ${SESSION}`
    )
  })

  it('pins behind posix env assignments, which are still command position', () => {
    expect(pinClaudeLaunchSessionId('FOO=1 claude', SESSION, 'posix')).toBe(
      `FOO=1 claude --session-id ${SESSION}`
    )
  })

  it('keeps the pin in option position, before claude’s own -- terminator', () => {
    expect(pinClaudeLaunchSessionId('claude -- --weird', SESSION, 'posix')).toBe(
      `claude --session-id ${SESSION} -- --weird`
    )
  })

  // Why: `--session-id` is a ROOT option. `claude mcp list --session-id <uuid>`
  // exits with "error: unknown option '--session-id'", so a trailing pin would
  // break a launch that works today — the pin must precede the subcommand.
  it.each([
    ['mcp list', 'claude mcp list'],
    ['doctor', 'claude doctor'],
    ['update', 'claude update'],
    ['setup-token', 'claude setup-token'],
    ['install stable', 'claude install stable']
  ])('pins ahead of the %s subcommand, never after it', (_label, command) => {
    const rest = command.slice('claude'.length)
    expect(pinClaudeLaunchSessionId(command, SESSION, 'posix')).toBe(
      `claude --session-id ${SESSION}${rest}`
    )
  })

  it('preserves the base bytes verbatim, including quoting', () => {
    expect(pinClaudeLaunchSessionId('claude "fix   the   bug"', SESSION, 'posix')).toBe(
      `claude --session-id ${SESSION} "fix   the   bug"`
    )
  })

  it('leaves a selector that follows claude’s own -- terminator alone', () => {
    // Why: past `--` the tokens are the child's argv, not claude flags, so they
    // are not a competing selector and must not suppress the pin.
    expect(pinClaudeLaunchSessionId('claude -- --resume abc', SESSION, 'posix')).toBe(
      `claude --session-id ${SESSION} -- --resume abc`
    )
  })

  it.each([
    ['--session-id', `claude --session-id ${SESSION}`],
    ['--session-id=', `claude --session-id=${SESSION}`],
    ['--resume', 'claude --resume abc'],
    ['--resume=', 'claude --resume=abc'],
    ['--continue', 'claude --continue'],
    ['--continue=', 'claude --continue=abc'],
    ['--fork-session', 'claude --fork-session'],
    ['-r', 'claude -r abc'],
    ['-r=', 'claude -r=abc'],
    ['-c', 'claude -c'],
    ['-c=', 'claude -c=abc']
  ])('refuses to compete with an existing %s selector', (_label, command) => {
    expect(pinClaudeLaunchSessionId(command, SESSION, 'posix')).toBeNull()
  })

  it.each([
    ['compound', 'claude && echo done'],
    ['sequenced', 'claude; echo done'],
    ['piped', 'claude | tee log'],
    ['redirected', 'claude > out.txt'],
    ['wrapper-launched', 'nvm exec claude'],
    ['not claude at all', 'codex'],
    ['a path that merely ends in claude', 'ssh -i ~/.ssh/claude host']
  ])('refuses to pin a %s command', (_label, command) => {
    expect(pinClaudeLaunchSessionId(command, SESSION, 'posix')).toBeNull()
  })

  it('refuses a PowerShell --% stop-parsing command', () => {
    expect(pinClaudeLaunchSessionId('claude --% --raw', SESSION, 'powershell')).toBeNull()
  })

  it('refuses a session id that is not a UUID', () => {
    expect(pinClaudeLaunchSessionId('claude', 'not-a-uuid', 'posix')).toBeNull()
    expect(pinClaudeLaunchSessionId('claude', '', 'posix')).toBeNull()
  })
})
