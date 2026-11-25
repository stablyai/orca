export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'

const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

/** Only host-proven absence permits cold resume. Exclude owner-mismatch suffixes: they describe another live pane, matching main’s isPtyAlreadyGoneError gate (docs/reference/ssh-execution-boundary.md). */
export function isSshSessionGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(SSH_SESSION_EXPIRED_ERROR) &&
    !message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR)
  )
}
