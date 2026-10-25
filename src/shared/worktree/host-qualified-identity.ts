import {
  getConnectionExecutionHostId,
  normalizeHostPart,
  parseExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { Worktree } from './types'

/** Use a printable separator: HTML replaces NUL in DOM attributes. Host IDs encode | as %7C, so host-first splitting stays exact even when workspace IDs contain |. */
const HOST_SEPARATOR = '|'

declare const hostScopedWorktreeKeyBrand: unique symbol

// Use for new stores only; retain existing raw-ID stores (D7).
export type HostScopedWorktreeKey = string & { readonly [hostScopedWorktreeKeyBrand]: true }

declare const hostWorktreeTargetBrand: unique symbol

/** One host's copy of a workspace, for destructive entry points that must not reach its twin. */
export type HostWorktreeTarget = {
  readonly id: string
  readonly hostId: ExecutionHostId
  readonly [hostWorktreeTargetBrand]: true
}

export function hostWorktreeTarget(row: {
  id: string
  hostId: ExecutionHostId
}): HostWorktreeTarget {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the only constructor of the brand; `hostId` is a concrete host by the parameter type.
  return { id: row.id, hostId: row.hostId } as HostWorktreeTarget
}

/** A PTY spawn's workspace copy: its `connectionId` is what picks the provider that runs it. */
export function spawnWorktreeTarget(
  worktreeId: string | undefined,
  connectionId: string | null | undefined
): HostWorktreeTarget | undefined {
  return worktreeId
    ? hostWorktreeTarget({
        id: worktreeId,
        hostId: getConnectionExecutionHostId(normalizeHostPart(connectionId))
      })
    : undefined
}

/** Separate copies of the same repoId::path on different hosts (STA-4343). Unqualified rows keep a separate bucket because their host is unproven. */
export function getWorktreeHostIdentity(
  worktree: Pick<Worktree, 'id' | 'hostId'>
): HostScopedWorktreeKey {
  return composeWorktreeHostIdentity(worktree.hostId, worktree.id)
}

export function composeWorktreeHostIdentity(
  hostId: ExecutionHostId | undefined,
  worktreeId: string
): HostScopedWorktreeKey {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this is the only constructor of the brand; the bytes are the unbranded composite, frozen by golden tests (D25).
  return `${hostId ?? ''}${HOST_SEPARATOR}${worktreeId}` as HostScopedWorktreeKey
}

/** An empty host prefix remains undefined; defaulting it to local could send a destructive action to the wrong host. */
export function getExecutionHostIdFromWorktreeHostIdentity(
  identity: string
): ExecutionHostId | undefined {
  const separatorIndex = identity.indexOf(HOST_SEPARATOR)
  if (separatorIndex <= 0) {
    return undefined
  }
  return parseExecutionHostId(identity.slice(0, separatorIndex))?.id
}

/** Recover the full workspace ID after the host delimiter. Indexes use this to avoid rereading worktree.id; retained selectors require one getter read per snapshot. */
export function getWorktreeIdFromHostIdentity(identity: string): string {
  return identity.slice(identity.indexOf(HOST_SEPARATOR) + 1)
}

/** A wire key back as a typed identity, or null when it is not one (a bare id). */
export function parseWorktreeHostIdentity(identity: string): HostScopedWorktreeKey | null {
  return isWorktreeHostIdentity(identity)
    ? composeWorktreeHostIdentity(
        getExecutionHostIdFromWorktreeHostIdentity(identity),
        getWorktreeIdFromHostIdentity(identity)
      )
    : null
}

/** True only for the canonical host-qualified form, not a legacy id containing `|`. */
export function isWorktreeHostIdentity(identity: string): boolean {
  const separator = identity.indexOf(HOST_SEPARATOR)
  return (
    separator === 0 ||
    (separator > 0 && parseExecutionHostId(identity.slice(0, separator)) !== null)
  )
}
