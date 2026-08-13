// Why this module exists: reattach failure used to converge on one action —
// spawn a fresh shell. A transport fault and a genuinely-gone session were
// indistinguishable at the decision point, so a transient error respawned the
// pane and resumed the same agent session a second time; both processes then
// appended to one transcript.
//
// Respawn now requires proof. Everything else is unresolved, which leaves the
// shell running and the binding intact for a later reattach.

/**
 * True only when the failure proves the session no longer exists.
 *
 * Nothing available at this decision point does. A not-found means the relay we asked cannot hand
 * that id back — which is proof of an exit ONLY if the relay process that minted the pty is the one
 * answering. A restarted or replaced relay reports not-found for shells that are still running
 * under its predecessor, and respawning there resumes the same agent a second time into one
 * transcript. `SSH_SESSION_EXPIRED` is not independent evidence: its only producer is that same
 * not-found mapping.
 *
 * Distinguishing the two needs `relayInstanceId` on the consumer grant (design step E-2), which is
 * not built. Until it is, the honest answer is "unproven", and an unverifiable pane surfaces as
 * disconnected for the user to resolve rather than being silently replaced.
 */
export function isProvenSshSessionGoneError(_error: unknown): boolean {
  return false
}
