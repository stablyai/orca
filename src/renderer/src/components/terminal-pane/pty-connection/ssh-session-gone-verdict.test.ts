import { describe, expect, it } from 'vitest'
import { isSshSessionGoneError } from './pty-connect-limits'

// The only gate the renderer has for "retire this pane's binding and cold-restore the agent into a
// fresh shell". Anything it accepts that the relay did not disown puts a second `--resume` on a
// running agent's transcript (docs/reference/ssh-execution-boundary.md).
describe('the renderer verdict that licenses replacing a pane PTY', () => {
  it('accepts the relay answering that this pane PTY is gone', () => {
    expect(isSshSessionGoneError(new Error('SSH_SESSION_EXPIRED: ssh:conn-1@@pty-1'))).toBe(true)
  })

  // The relay found a LIVE PTY under that id belonging to another pane. It observed nothing about
  // this pane's process, and main's own gate (`isPtyAlreadyGoneError`) already refuses to respawn
  // on it — the renderer read the same message as absence and respawned anyway.
  it('refuses an identity mismatch, which names a live PTY owned by another pane', () => {
    expect(
      isSshSessionGoneError(
        new Error('SSH_SESSION_EXPIRED: ssh:conn-1@@pty-1 SSH_PTY_IDENTITY_MISMATCH')
      )
    ).toBe(false)
  })

  it('refuses an identity mismatch wrapped by the IPC boundary', () => {
    expect(
      isSshSessionGoneError(
        "Error invoking remote method 'pty:spawn': Error: SSH_SESSION_EXPIRED: ssh:conn-1@@pty-1 SSH_PTY_IDENTITY_MISMATCH"
      )
    ).toBe(false)
  })

  // A live PTY whose output delivery needs reopening: main no longer wears the expiry token for it,
  // and the verdict must stay `unverifiable` even if some future caller reintroduces the wording.
  it('refuses a source-restore verdict for a PTY the relay just proved alive', () => {
    expect(
      isSshSessionGoneError(
        new Error('SSH_PTY_SOURCE_RESTORE_REQUIRED: ssh:conn-1@@pty-1 checkpointUnavailable')
      )
    ).toBe(false)
  })

  it.each([
    ['a lost link', 'SSH connection lost, reconnecting...'],
    ['a request timeout', 'Request "pty.attach" timed out after 10000ms'],
    ['a disposed multiplexer', 'Multiplexer disposed']
  ])('refuses %s', (_label, message) => {
    expect(isSshSessionGoneError(new Error(message))).toBe(false)
  })
})
