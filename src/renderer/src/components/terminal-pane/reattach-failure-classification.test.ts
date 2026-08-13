/**
 * Duplicate-agent oracles. Reattach failure used to converge on "spawn a fresh
 * shell", so a transient fault started a second `--resume` against the same
 * agent session and both processes appended to one transcript.
 *
 * Respawn requires proof the session is gone. These pin which failures qualify.
 */
import { describe, expect, it } from 'vitest'
import { isProvenSshSessionGoneError } from './reattach-failure-classification'

describe('reattach failure classification', () => {
  // INVERTED for STA-3077. Both clauses below asserted that a not-found — raw, or wrapped as
  // SSH_SESSION_EXPIRED — proves the shell is gone. It does not, and this was the last live route
  // to the reported duplicate resume.
  //
  // A not-found means the relay WE ASKED cannot hand that id back. That is proof of an exit only
  // if the relay process that minted the pty is the one answering. When a relay is restarted or
  // replaced, the new process reports not-found for shells still running under its predecessor —
  // observed directly in the Docker relay harness, where a stalled relay is superseded by a fresh
  // one with no memory of `pty-1` while the old shells keep running. Respawning there starts a
  // second `--resume` against the same agent session.
  //
  // SSH_SESSION_EXPIRED is not independent evidence: its ONLY producer is that same not-found
  // mapping in reattachSshPtySession. Telling the two apart needs `relayInstanceId` on the consumer
  // grant (design step E-2), which is not built — so the honest answer is "unproven".
  it('does not treat an explicit host expiry as proof', () => {
    expect(isProvenSshSessionGoneError(new Error('SSH_SESSION_EXPIRED: ssh-1:pty-9'))).toBe(false)
  })

  it('does not treat a not-found PTY as proof', () => {
    expect(isProvenSshSessionGoneError(new Error('PTY "pty-9" not found'))).toBe(false)
  })

  // The reported defect: a source that needs re-establishing was reported as
  // expiry, so the pane respawned and duplicate-resumed a live agent session.
  it('does not treat a required source restore as proof', () => {
    expect(isProvenSshSessionGoneError(new Error('SSH_SOURCE_RESTORE_REQUIRED: ssh-1:pty-9'))).toBe(
      false
    )
  })

  it.each([
    ['a transport fault', new Error('read ECONNRESET')],
    ['a timed-out call', new Error('relay request timed out')],
    ['a disconnected client', new Error('client_disconnected')],
    ['an unavailable owner', new Error('execution_owner_unavailable')],
    ['an identity mismatch', new Error('SSH_PTY_IDENTITY_MISMATCH')],
    ['an empty rejection value', ''],
    ['a non-Error rejection', 'something went wrong']
  ])('does not treat %s as proof', (_label, error) => {
    expect(isProvenSshSessionGoneError(error)).toBe(false)
  })

  // A new failure mode must not silently become a respawn.
  it('defaults an unrecognized failure to unresolved', () => {
    expect(isProvenSshSessionGoneError(new Error('SOME_FUTURE_RELAY_ERROR'))).toBe(false)
  })
})

// The `reattach failure description` cases moved rather than vanished. An unproven failure no
// longer renders an error string at all — it renders the disconnected banner with two actions
// (STA-3077 step E-0), so "keeps the wire token out of the pane" is now asserted against that
// copy in TerminalPaneDisconnectedBanner.test.tsx, alongside the no-death-verbs constraint.

// An identity mismatch is the relay saying "I have this pty and its recorded
// pane differs" — proof the shell is ALIVE. It is worded "not found", so the
// not-found regex alone reads it backwards and respawns onto a live shell,
// resuming the agent a second time. Reachable by detaching a pane to a new tab.
describe('an identity mismatch is never proof of death', () => {
  it('refuses the token main publishes', () => {
    const error = new Error('SSH_PTY_IDENTITY_MISMATCH: pty-7')
    expect(isProvenSshSessionGoneError(error)).toBe(false)
  })

  // Defense in depth: any route that surfaces the relay's raw wording unwrapped
  // must not read as death either.
  it('refuses the relay wording unwrapped', () => {
    const error = new Error('PTY "pty-7" not found (identity mismatch)')
    expect(isProvenSshSessionGoneError(error)).toBe(false)
  })

  // INVERTED with the two clauses above. This was the clause-selectivity guard: it pinned that
  // silencing the mismatch case had not silenced plain expiry too. Plain expiry is now unproven as
  // well, on its own evidence — so what remains to guard is that the pane is not stranded, and that
  // is the disconnected affordance's job, asserted in TerminalPaneDisconnectedBanner.test.tsx.
  it('does not prove death for the same wording without the mismatch clause either', () => {
    expect(isProvenSshSessionGoneError(new Error('PTY "pty-7" not found'))).toBe(false)
  })
})

/**
 * The respawn arms are now unreachable, and that is the point: no reattach failure authorizes
 * replacing a running shell. The design keeps the grant as a CONDITIONAL for step E-2 — a
 * not-found whose `relayInstanceId` matches the recorded one is genuine proof — so the decision
 * point stays rather than being deleted. This clause pins that nothing reaches it meanwhile.
 */
describe('no reattach failure authorizes a respawn today', () => {
  it.each([
    ['a relay-worded not-found', new Error('PTY "pty-9" not found')],
    ['the expiry token main publishes', new Error('SSH_SESSION_EXPIRED: ssh-1:pty-9')],
    ['an identity mismatch', new Error('SSH_PTY_IDENTITY_MISMATCH: pty-7')],
    ['a required source restore', new Error('SSH_SOURCE_RESTORE_REQUIRED: ssh-1:pty-9')],
    ['a transport fault', new Error('read ECONNRESET')]
  ])('leaves %s unproven', (_label, error) => {
    expect(isProvenSshSessionGoneError(error)).toBe(false)
  })
})
