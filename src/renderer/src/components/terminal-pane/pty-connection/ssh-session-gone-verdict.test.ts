import { describe, expect, it } from 'vitest'
import { isSshSessionGoneError } from './pty-connect-limits'

// Only host-proven absence authorizes retirement/cold resume; accepting unverifiable errors duplicates live transcripts (docs/reference/ssh-execution-boundary.md).
describe('the renderer verdict that licenses replacing a pane PTY', () => {
  it('accepts the relay answering that this pane PTY is gone', () => {
    expect(isSshSessionGoneError(new Error('SSH_SESSION_EXPIRED: ssh:conn-1@@pty-1'))).toBe(true)
  })

  // Owner mismatch proves another pane’s PTY is live, not this pane’s absence; renderer must agree with main’s isPtyAlreadyGoneError refusal.
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

  // Delivery loss for a live PTY stays unverifiable even if future wording accidentally includes the expiry token.
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
