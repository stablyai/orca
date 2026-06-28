// Renderer-side liveness reconciliation for terminal panes whose daemon PTY
// session was reaped while the worktree was surface-hidden. On visibility
// resume the missed `pty:exit` left the pane mounted bound to a dead session;
// this routes such panes through the same exit teardown an observed exit runs.
// See design-docs/terminal-dead-pane-on-bg-exit.md.

const REMOTE_PTY_ID_PREFIX = 'remote:'

/**
 * A pane binding that exposes its bound transport identity plus a reconcile
 * hook. Kept structural so the lifecycle fan-out can call it without importing
 * the full `PanePtyBinding` shape from pty-connection.
 */
export type ReconcilableBinding = {
  reconcileIfSessionDead?: (liveSessionIds: Set<string>) => void
}

/**
 * PURE decision: should the pane bound to `ptyId` be reconciled (torn down)
 * given the resolved set of live session ids?
 *
 * Reconcile ONLY when every guard passes:
 * - `ptyId` is non-null (a mid-spawn pane has no id to prove dead).
 * - `ptyId` is not `remote:`-prefixed (web-runtime liveness is owned by the
 *   host snapshot, not `listSessions`).
 * - `connectionId === null` — the id is local/daemon-backed. SSH-backed ids
 *   (non-null connectionId) are deferred: the flat `listSessions` shape cannot
 *   authoritatively prove an SSH session gone (see design Section 1).
 * - the id is genuinely absent from the resolved live set.
 */
export function shouldReconcileDeadSession(args: {
  ptyId: string | null | undefined
  connectionId: string | null | undefined
  liveSessionIds: Set<string>
}): boolean {
  const { ptyId, connectionId, liveSessionIds } = args
  if (ptyId === null || ptyId === undefined) {
    return false
  }
  if (ptyId.startsWith(REMOTE_PTY_ID_PREFIX)) {
    return false
  }
  // Why: only local/daemon-backed ids (connectionId null/undefined) are
  // reconcilable; a non-null connectionId means SSH, which is deferred.
  if (connectionId !== null && connectionId !== undefined) {
    return false
  }
  return !liveSessionIds.has(ptyId)
}

/**
 * Thin orchestration: fetch the live session listing once and invoke each
 * binding's `reconcileIfSessionDead` with the resolved set.
 *
 * Why a rejected `listSessions()` is swallowed (no reconcile): the local
 * provider listing is NOT `.catch`-wrapped in main, so a rejection means the
 * listing is unknown — closing a pane on an IPC/listing failure is unacceptable.
 * A RESOLVED list (even empty `[]`) is AUTHORITATIVE for local ids: a local id
 * absent from it is genuinely reaped, so there is no zero-total skip.
 */
export async function reconcileDeadSessions(args: {
  bindings: Iterable<ReconcilableBinding>
  listSessions: () => Promise<{ id: string; cwd: string; title: string }[]>
}): Promise<void> {
  let sessions: { id: string }[]
  try {
    sessions = await args.listSessions()
  } catch {
    // Why: a rejected listing is "unknown" — never close a pane on it.
    return
  }
  const liveSessionIds = new Set(sessions.map((session) => session.id))
  for (const binding of args.bindings) {
    binding.reconcileIfSessionDead?.(liveSessionIds)
  }
}
