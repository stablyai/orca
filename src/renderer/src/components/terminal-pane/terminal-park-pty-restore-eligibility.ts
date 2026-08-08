/**
 * Whether one hidden terminal PTY may be parked and later restored.
 *
 * Why split from terminal-hidden-view-parking: that module owns the timing
 * policy (hysteresis clock, hot-retain cap, recheck deadlines) its verdicts are
 * built from; this one owns the per-PTY ownership question every verdict gates
 * on, so the two grow independently.
 */
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { PTY_SESSION_ID_SEPARATOR } from '../../../../shared/pty-session-id-format'
import { TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

// Why: snapshot-backed = local daemon session owned by this worktree (foreign
// ids reattach through a path parking cannot replay). SSH is restorable too,
// via isParkRestorableTerminalPty + main's headless model; only remote-runtime
// ptys, which never transit main, stay unrestorable.
export function isSnapshotBackedTerminalPty(ptyId: string | null, worktreeId: string): boolean {
  if (!ptyId) {
    return false
  }
  if (isRemoteRuntimePtyId(ptyId) || parseAppSshPtyId(ptyId)) {
    return false
  }
  // Why: separator-less ids come from the daemon-fail-open LocalPtyProvider;
  // they have no daemon session model, so revealing a parked pane would
  // silently respawn a fresh shell instead of restoring the snapshot.
  const separatorIdx = ptyId.lastIndexOf(PTY_SESSION_ID_SEPARATOR)
  return separatorIdx !== -1 && ptyId.slice(0, separatorIdx) === worktreeId
}

export type TerminalParkRestorePolicy = {
  /** settings.terminalSshViewParking !== false — the C1 SSH-parking kill switch. */
  sshParkingEnabled?: boolean
  /** Exact paired environments whose host advertises bounded snapshot restore. */
  pairedRuntimeParkingEnvironmentIds?: ReadonlySet<string>
}

/** What the worktree's own transport resolves to, from the same sources the spawn path uses. */
export type TerminalParkWorktreeOwner = {
  /** `undefined` when the repo has not hydrated; `null` when the worktree is local. */
  connectionId: string | null | undefined
  runtimeEnvironmentId: string | null
}

export function selectPairedRuntimeParkingEnvironmentIds(
  statuses: ReadonlyMap<string, { status: { capabilities?: readonly string[] } | null | undefined }>
): Set<string> {
  const capable = new Set<string>()
  for (const [environmentId, entry] of statuses) {
    if (entry.status?.capabilities?.includes(TERMINAL_PAIRED_PARKING_RUNTIME_CAPABILITY)) {
      capable.add(environmentId)
    }
  }
  return capable
}

// Why: an owner the resolver left unproven is not evidence of a foreign session,
// and refusing one strips the tab's parked watchers (bells, titles, completions)
// while the pane is torn down anyway.
function isProvenForeignOwner(worktreeOwner: string | null | undefined, ptyOwner: string): boolean {
  return Boolean(worktreeOwner) && worktreeOwner !== ptyOwner
}

// Why: SSH uses local main's model; paired PTYs are eligible only when their
// exact host advertises authoritative bounded restore. On top of that, a pty
// whose embedded owner is *known* to be a different connection or environment is
// some other worktree's session, so parking it here would reveal a stranger's
// shell. Not a guard against relay pty-id reuse: two worktrees on one connection
// share a connection id, so no owner comparison can separate them.
export function isParkRestorableTerminalPty(
  ptyId: string | null,
  worktreeId: string,
  worktreeOwner: TerminalParkWorktreeOwner,
  policy?: TerminalParkRestorePolicy
): boolean {
  if (isSnapshotBackedTerminalPty(ptyId, worktreeId)) {
    return true
  }
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    return (
      environmentId !== null &&
      !isProvenForeignOwner(worktreeOwner.runtimeEnvironmentId, environmentId) &&
      policy?.pairedRuntimeParkingEnvironmentIds?.has(environmentId) === true
    )
  }
  const sshConnectionId = ptyId ? (parseAppSshPtyId(ptyId)?.connectionId ?? null) : null
  return (
    policy?.sshParkingEnabled === true &&
    sshConnectionId !== null &&
    !isProvenForeignOwner(worktreeOwner.connectionId, sshConnectionId)
  )
}
