// Why shared: main publishes these tokens and the renderer decides whether to
// respawn on them. They lived in two places, and the copies disagreed about
// what an identity mismatch meant — main marked it, the renderer ignored the
// mark and respawned a live shell. One definition, so a change reaches both.

import { isRelayAttestedPtyIncarnationId } from './pty-incarnation'

/** The host proved the session is gone. Callers may respawn. */
export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'

/** The relay FOUND the pty and its recorded pane differs, so the shell is
 *  running. The relay words this as "not found", which is why matching on that
 *  phrasing alone reads a live shell as a dead one. Never grounds a respawn. */
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

/** The shell is alive; only its output source must be re-established. */
export const SSH_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_SOURCE_RESTORE_REQUIRED'

/** The relay WATCHED this exit, so it proves death — unlike an unknown id, which a replacement
 *  relay also answers for shells still running. Worded to never read as `not found`, which older
 *  clients map to expiry, and expiry authorizes a respawn. */
export const SSH_PTY_EXITED_ERROR = 'SSH_PTY_EXITED'

/** The carrier is the message: the relay's error transport drops structured payloads. */
export function formatPtyExitedError(id: string, code: number, incarnationId: string): string {
  return `${SSH_PTY_EXITED_ERROR}: ${encodeURIComponent(id)} code=${code} incarnation=${encodeURIComponent(incarnationId)}`
}

/** Whole grammar, not the token: this authorizes replacing a shell, so any text merely quoting the
 *  token must not qualify. Fields are percent-encoded at the source, so none can forge the next. */
const SSH_PTY_EXITED_MESSAGE = new RegExp(
  `(?:^|[^A-Z_])${SSH_PTY_EXITED_ERROR}: ([^\\s]+) code=(-?\\d+) incarnation=([^\\s]+)`
)

export function isSshPtyExitedMessage(message: string): boolean {
  return SSH_PTY_EXITED_MESSAGE.test(message)
}

/** The shell the proof names. Callers must check it themselves: the host applies the same rule, but
 *  the host is the party whose answer is in question and versions differ. */
export function parsePtyExitedError(
  message: string
): { id: string; code: number; incarnationId: string } | null {
  const match = SSH_PTY_EXITED_MESSAGE.exec(message)
  if (!match) {
    return null
  }
  try {
    return {
      id: decodeURIComponent(match[1]!),
      code: Number(match[2]),
      incarnationId: decodeURIComponent(match[3]!)
    }
  } catch {
    // Malformed encoding cannot be trusted to name a shell, so it names none.
    return null
  }
}

export function parseMatchingPtyExitedError(
  message: string,
  expectedId: string,
  expectedIncarnationId: unknown
): { id: string; code: number; incarnationId: string } | null {
  const proof = parsePtyExitedError(message)
  return proof &&
    proof.id === expectedId &&
    isRelayAttestedPtyIncarnationId(expectedIncarnationId) &&
    proof.incarnationId === expectedIncarnationId
    ? proof
    : null
}

export function isSshPtyIdentityMismatchMessage(message: string): boolean {
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}
