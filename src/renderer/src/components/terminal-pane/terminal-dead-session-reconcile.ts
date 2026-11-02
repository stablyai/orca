// Renderer-side liveness reconciliation for terminal panes whose daemon PTY
// session was reaped while the worktree was surface-hidden. On visibility
// resume the missed `pty:exit` left the pane mounted bound to a dead session;
// this routes such panes through the same exit teardown an observed exit runs.
// See design-docs/terminal-dead-pane-on-bg-exit.md.

import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'

/**
 * A pane binding that exposes its bound transport identity plus a reconcile
 * hook. Kept structural so the lifecycle fan-out can call it without importing
 * the full `PanePtyBinding` shape from pty-connection.
 */
export type ReconcilableBinding = {
  reconcileIfSessionMissing?: (hasPty: HasPty, livenessRequestedAt?: number) => void
}

export type HasPty = (ptyId: string) => Promise<boolean | null>

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
  ptyBoundAt?: number | null
  snapshotRequestedAt?: number | null
}): boolean {
  const { ptyId, connectionId, liveSessionIds, ptyBoundAt, snapshotRequestedAt } = args
  if (ptyId === null || ptyId === undefined) {
    return false
  }
  if (isRemoteRuntimePtyId(ptyId)) {
    return false
  }
  // Why: only local/daemon-backed ids (connectionId null/undefined) are
  // reconcilable; a non-null connectionId means SSH, which is deferred.
  if (connectionId !== null && connectionId !== undefined) {
    return false
  }
  // Why: a snapshot requested before this binding existed can't prove it dead
  // (newborn-PTY reconcile race). Omitting either timestamp keeps prior
  // pure-membership behavior (back-compat).
  if (
    typeof ptyBoundAt === 'number' &&
    typeof snapshotRequestedAt === 'number' &&
    ptyBoundAt >= snapshotRequestedAt
  ) {
    return false
  }
  return !liveSessionIds.has(ptyId)
}

export function shouldReconcileMissingSession(args: {
  ptyId: string | null | undefined
  connectionId: string | null | undefined
  isLive: boolean | null | undefined
  ptyBoundAt?: number | null
  livenessRequestedAt?: number | null
}): boolean {
  if (args.isLive !== false) {
    return false
  }
  return shouldReconcileDeadSession({
    ptyId: args.ptyId,
    connectionId: args.connectionId,
    liveSessionIds: new Set(),
    ptyBoundAt: args.ptyBoundAt,
    snapshotRequestedAt: args.livenessRequestedAt
  })
}

export function reconcileMissingSessions(args: {
  bindings: Iterable<ReconcilableBinding>
  hasPty: HasPty
}): void {
  // Why: the liveness request time must predate every async response so a
  // stale response cannot close a PTY that bound after the request started.
  const requestedAt = performance.now()
  for (const binding of args.bindings) {
    binding.reconcileIfSessionMissing?.(args.hasPty, requestedAt)
  }
}
