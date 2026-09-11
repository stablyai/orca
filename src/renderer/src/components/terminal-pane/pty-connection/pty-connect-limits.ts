import { e2eConfig } from '@/lib/e2e-config'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from '../remote-runtime-pty-recovery-state'

export const pendingSpawnByPaneKey = new Map<string, Promise<string | null>>()
export const pendingSpawnGenerationByPaneKey = new Map<string, number>()
export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'
const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

/**
 * True only when the host answered that this pane's PTY is gone, which is the one thing that
 * licenses retiring the binding and cold-restoring the agent into a fresh shell.
 *
 * The mismatch suffix is excluded because it means the opposite: the relay found a LIVE PTY under
 * that id owned by another pane, and says nothing about this pane's process. Respawning there puts
 * a second agent on one transcript (docs/reference/ssh-execution-boundary.md). Main already refuses
 * to respawn on it — `isPtyAlreadyGoneError` takes the class, not the message — so a bare substring
 * test here silently disagreed with the gate one process over.
 */
export function isSshSessionGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes(SSH_SESSION_EXPIRED_ERROR) &&
    !message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR)
  )
}
// Why: relay requests expire at 30s; leave one second for their fallback before re-arming locally.
export const DIRECT_SSH_PANE_RETRY_SETTLEMENT_TIMEOUT_MS = 31_000
export const REMOTE_PTY_ID_PREFIX = 'remote:'
export const PTY_CONNECT_DIAG_LIMIT = 200
export const MANUAL_AGENT_COMMAND_MAX_CHARS = 4096
export const STARTUP_DRAFT_PASTE_QUIET_MS = 1500
// Why a grace window instead of a plain flag: a connect that never settles
// (SSH RPC timeout class, wedged daemon call) would otherwise suppress
// input-triggered recovery FOREVER — and such a pane has no output flowing,
// so no other detector can fire. Past the grace, undeliverable input may
// recover again; the transport's destroyed-check no longer kills a
// pre-existing session when a late reattach resolves, so a remount racing
// a slow-but-alive connect costs a wasted view rebuild, not a shell.
export const TRANSPORT_CONNECT_SETTLE_GRACE_MS = 60_000
// Why its own constant and not the grace above: this bounds how long a PANE waits on
// a spawn that may never settle, a different policy with a different failure mode, so
// tuning one must not silently move the other.
//
// Why derived rather than picked: it must outlast every settle main can legitimately
// take, and a local cold start spends its budgets SEQUENTIALLY. `pty:spawn` first
// awaits the first-window startup gate (main `LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS`,
// because the daemon provider swap overlaps first paint), and only then does the daemon
// client spend its connection-attempt wait plus one request timeout. A plain 60s fired
// while main was still inside the gate — remounting a spawn that was about to succeed,
// on exactly the cold start where every restored pane is spawning at once.
// Erring long costs a longer wait on a pane that is already stuck; erring short kills a
// live spawn. `spawn-settlement-watchdog-budget.test.ts` pins these against main.
const LOCAL_PTY_STARTUP_GATE_CEILING_MS = 60_000
const DAEMON_SPAWN_SETTLE_CEILING_MS = 20_000 + 30_000
export const SPAWN_SETTLEMENT_WATCHDOG_MS =
  LOCAL_PTY_STARTUP_GATE_CEILING_MS + DAEMON_SPAWN_SETTLE_CEILING_MS + 30_000
// Why a second, longer deadline: a remote-runtime create does not fail fast. It runs
// its own retry ladder inside the create call, arming REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
// on the first recoverable connection error, so the connect promise legitimately pends
// past the local deadline on a flapping link. Timing that out would remount a pane whose
// create is still running and can orphan a host terminal.
export const REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS =
  REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS + 30_000

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
