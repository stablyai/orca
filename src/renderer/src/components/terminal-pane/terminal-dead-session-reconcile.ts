// On visibility resume, route daemon sessions reaped while hidden through normal exit teardown (design-docs/terminal-dead-pane-on-bg-exit.md).

import { isRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'

/** Structural binding keeps lifecycle fan-out independent of the full PanePtyBinding import. */
export type ReconcilableBinding = {
  reconcileIfSessionMissing?: (hasPty: HasPty, livenessRequestedAt?: number) => void
}

export type HasPty = (ptyId: string) => Promise<boolean | null>

/** Only local daemon session absence can prove death; remote-runtime and SSH liveness require their owning host’s evidence. */
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
  // SSH IDs are not authoritative in the flat local session list.
  if (connectionId !== null && connectionId !== undefined) {
    return false
  }
  // A pre-bind snapshot cannot prove death; missing timestamps preserve legacy membership-only behavior.
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
  // Record request time before async responses to protect bindings created while the request was in flight.
  const requestedAt = performance.now()
  for (const binding of args.bindings) {
    binding.reconcileIfSessionMissing?.(args.hasPty, requestedAt)
  }
}
