import { describe, expect, it } from 'vitest'
import { withInlineEnvAssignments } from './inline-env-command-prefix'

const ENV = { ORCA_AGENT_SESSION_NONCE: 'nonce-1' }

describe('inline env assignments for a typed command', () => {
  it('leaves the command untouched when there is nothing to assign', () => {
    expect(
      withInlineEnvAssignments({ command: 'codex resume x', env: {}, platform: 'darwin' })
    ).toBe('codex resume x')
  })

  // Why one POSIX form rather than a fish dialect: Orca cannot reliably detect the login shell of a
  // remote or WSL host, so `AgentStartupShell` deliberately has no fish member. The single emitted
  // form has to parse in every Unix shell instead, which is what this pins.
  it('uses env(1) on POSIX so fish parses it too', () => {
    expect(
      withInlineEnvAssignments({
        command: "codex resume 'thread-1'",
        env: ENV,
        platform: 'linux',
        shell: 'posix'
      })
      // Why not `NAME=value cmd`: fish rejects that form outright.
    ).toBe("env ORCA_AGENT_SESSION_NONCE='nonce-1' codex resume 'thread-1'")
  })

  it('emits that same fish-safe form when no shell is given', () => {
    expect(
      withInlineEnvAssignments({ command: 'codex resume x', env: ENV, platform: 'darwin' })
    ).toBe("env ORCA_AGENT_SESSION_NONCE='nonce-1' codex resume x")
  })

  it('uses PowerShell and cmd assignment syntax on Windows', () => {
    expect(
      withInlineEnvAssignments({
        command: 'codex resume thread-1',
        env: ENV,
        platform: 'win32',
        shell: 'powershell'
      })
    ).toBe("$env:ORCA_AGENT_SESSION_NONCE='nonce-1'; codex resume thread-1")
    expect(
      withInlineEnvAssignments({
        command: 'codex resume thread-1',
        env: ENV,
        platform: 'win32',
        shell: 'cmd'
      })
    ).toBe('set "ORCA_AGENT_SESSION_NONCE=nonce-1" && codex resume thread-1')
  })

  it('quotes values for the target dialect', () => {
    expect(
      withInlineEnvAssignments({
        command: 'codex',
        env: { N: "it's" },
        platform: 'darwin',
        shell: 'posix'
      })
      // Why this idiom and not `'\''`: closing, adding a double-quoted quote, then reopening parses
      // in fish too, which does not honour a backslash escape inside single quotes.
    ).toContain(`N='it'"'"'s'`)
    expect(
      withInlineEnvAssignments({
        command: 'codex',
        env: { N: "it's" },
        platform: 'win32',
        shell: 'powershell'
      })
    ).toContain(`$env:N='it''s'`)
  })
})
