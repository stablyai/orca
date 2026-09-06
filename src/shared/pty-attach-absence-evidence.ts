/**
 * `pty.attach` refuses with `PTY "<id>" not found` for two unrelated situations: a pid the relay
 * probed and found gone, and an id its session map simply never had — which is every id minted
 * before a relay restart, since ids carry a per-start mint epoch. Only the first observes the
 * process, so only the first carries this marker.
 *
 * The marker is additive on purpose: an answer without it means "ambiguous", which is also what an
 * older relay's unmarked answer means, so a client may never read a missing marker as evidence of
 * anything (docs/reference/ssh-execution-boundary.md).
 */
export const PTY_ATTACH_PROVEN_EXITED_MARKER = 'process exited'

const PROVEN_EXITED_ATTACH_REFUSAL = /PTY ".+" not found \(process exited\)/i

export function isProvenExitedPtyAttachRefusal(error: unknown): boolean {
  return PROVEN_EXITED_ATTACH_REFUSAL.test(error instanceof Error ? error.message : String(error))
}
