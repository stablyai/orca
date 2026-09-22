import { describe, expect, it } from 'vitest'
import { describeUnconfirmedAgentStop, describeUnconfirmedStop } from './pty-liveness-verdict'

describe('unconfirmed-stop sentences', () => {
  it('terminates a reason that has no terminator', () => {
    expect(describeUnconfirmedStop('its SSH provider is no longer registered')).toBe(
      'The PTY was not confirmed stopped: its SSH provider is no longer registered.'
    )
  })

  it('does not double the terminator on a reason that is already a sentence', () => {
    // A relayed lifecycle_conflict message arrives punctuated and printed `...to failed..`.
    expect(
      describeUnconfirmedAgentStop({
        ptyStopVerdict: 'unverifiable',
        ptyStopReason: 'worker w1 cannot transition from stopping to failed.'
      })
    ).toBe(
      'The agent terminal was closed but its process could not be confirmed stopped: worker w1 cannot transition from stopping to failed.'
    )
  })

  it('still terminates the live-process wording', () => {
    expect(describeUnconfirmedAgentStop({ ptyStopVerdict: 'live' })).toBe(
      'The agent terminal was closed but its process could not be confirmed stopped: it is live.'
    )
  })
})
