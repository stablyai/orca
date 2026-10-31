import { e2eConfig } from '@/lib/e2e-config'

export const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
export const pendingSpawnGenerationByPaneKey = new Map<string, number>()
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

/**
 * The terminal daemon's absence answer for a reattach id (`SessionNotFoundError` in
 * daemon-errors.ts, possibly class-prefixed or IPC-wrapped on the way back). Expected at project
 * open for any pane whose session died with a daemon restart or the project-close sweep, so it
 * licenses the same silent retire-and-respawn the SSH expiry verdict gets.
 */
export function isDaemonSessionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /(?:SessionNotFoundError: )?Session not found: \S+/.test(message)
}
export const PTY_CONNECT_DIAG_LIMIT = 200
export const MANUAL_AGENT_COMMAND_MAX_CHARS = 4096
export const STARTUP_DRAFT_PASTE_QUIET_MS = 1500
// Bound connect grace so wedged RPCs cannot suppress input recovery forever; late reattach does not authorize killing pre-existing sessions.
export const TRANSPORT_CONNECT_SETTLE_GRACE_MS = 60_000

export function recordPtyConnectDiagnostic(message: string): void {
  if (!e2eConfig.exposeStore) {
    return
  }
  console.log(`[pty-connect] ${message}`)
  const target = globalThis as Record<string, unknown>
  const diag = (target.__ptyConnectDiag ??= [] as string[]) as string[]
  diag.push(message)
  if (diag.length > PTY_CONNECT_DIAG_LIMIT) {
    diag.splice(0, diag.length - PTY_CONNECT_DIAG_LIMIT)
  }
}
