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
import { hasWebSessionTerminalParkAuthority } from '@/runtime/web-session-terminal-park-authority'

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
export type TerminalParkWorktreeOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'unknown' }
  | { kind: 'ambiguous' }

export type TerminalParkPaneIdentity = { tabId: string; leafId: string | null }

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

export function hasTerminalParkPtyOwnerAuthority(
  ptyId: string,
  worktreeId: string,
  worktreeOwner: TerminalParkWorktreeOwner,
  paneIdentity?: TerminalParkPaneIdentity
): boolean {
  if (isRemoteRuntimePtyId(ptyId)) {
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    if (environmentId === null) {
      return false
    }
    if (worktreeOwner.kind === 'runtime') {
      return worktreeOwner.environmentId === environmentId
    }
    return (
      worktreeOwner.kind === 'local' &&
      paneIdentity?.leafId != null &&
      hasWebSessionTerminalParkAuthority({
        environmentId,
        worktreeId,
        tabId: paneIdentity.tabId,
        leafId: paneIdentity.leafId,
        ptyId
      })
    )
  }
  const sshConnectionId = parseAppSshPtyId(ptyId)?.connectionId ?? null
  if (sshConnectionId !== null) {
    return worktreeOwner.kind === 'ssh' && worktreeOwner.connectionId === sshConnectionId
  }
  return isSnapshotBackedTerminalPty(ptyId, worktreeId)
}

export function isParkRestorableTerminalPty(
  ptyId: string | null,
  worktreeId: string,
  worktreeOwner: TerminalParkWorktreeOwner,
  policy?: TerminalParkRestorePolicy,
  paneIdentity?: TerminalParkPaneIdentity
): boolean {
  if (isSnapshotBackedTerminalPty(ptyId, worktreeId)) {
    return true
  }
  if (ptyId && isRemoteRuntimePtyId(ptyId)) {
    const environmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
    if (
      environmentId === null ||
      policy?.pairedRuntimeParkingEnvironmentIds?.has(environmentId) !== true
    ) {
      return false
    }
    return hasTerminalParkPtyOwnerAuthority(ptyId, worktreeId, worktreeOwner, paneIdentity)
  }
  const sshConnectionId = ptyId ? (parseAppSshPtyId(ptyId)?.connectionId ?? null) : null
  return (
    policy?.sshParkingEnabled === true &&
    ptyId !== null &&
    sshConnectionId !== null &&
    hasTerminalParkPtyOwnerAuthority(ptyId, worktreeId, worktreeOwner, paneIdentity)
  )
}
