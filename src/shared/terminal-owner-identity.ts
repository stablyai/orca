import type { ExecutionHostId } from './execution-host'
import { normalizeExecutionHostId } from './execution-host'
import type { PtyIncarnationId } from './pty-incarnation'

/** The execution authority that owns a persisted terminal session. */
export type TerminalOwnerKind =
  | 'daemon'
  | 'ssh'
  | 'wsl'
  | 'relay'
  | 'paired-runtime'
  | 'local-direct'

/**
 * Durable identity for a terminal owner. A logical PTY id is deliberately not
 * included: it is a product handle and may be reused by a later session.
 */
export type TerminalOwnerIdentity = {
  executionHostId: ExecutionHostId
  ownerKind: TerminalOwnerKind
  ownerIncarnationId: string
  sessionIncarnationId: PtyIncarnationId
  protocolVersion: number
  /** Opaque endpoint reference, never an auth token or socket credential. */
  endpointRef?: string
}

export function isTerminalOwnerIdentity(value: unknown): value is TerminalOwnerIdentity {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<TerminalOwnerIdentity>
  return (
    typeof candidate.executionHostId === 'string' &&
    normalizeExecutionHostId(candidate.executionHostId) !== null &&
    (candidate.ownerKind === 'daemon' ||
      candidate.ownerKind === 'ssh' ||
      candidate.ownerKind === 'wsl' ||
      candidate.ownerKind === 'relay' ||
      candidate.ownerKind === 'paired-runtime' ||
      candidate.ownerKind === 'local-direct') &&
    typeof candidate.ownerIncarnationId === 'string' &&
    candidate.ownerIncarnationId.length > 0 &&
    typeof candidate.sessionIncarnationId === 'string' &&
    candidate.sessionIncarnationId.length > 0 &&
    typeof candidate.protocolVersion === 'number' &&
    Number.isInteger(candidate.protocolVersion) &&
    candidate.protocolVersion > 0 &&
    (candidate.endpointRef === undefined || typeof candidate.endpointRef === 'string')
  )
}

export function sameTerminalOwnerIdentity(
  left: TerminalOwnerIdentity | null | undefined,
  right: TerminalOwnerIdentity | null | undefined
): boolean {
  return Boolean(
    left &&
    right &&
    left.executionHostId === right.executionHostId &&
    left.ownerKind === right.ownerKind &&
    left.ownerIncarnationId === right.ownerIncarnationId &&
    left.sessionIncarnationId === right.sessionIncarnationId &&
    left.protocolVersion === right.protocolVersion &&
    left.endpointRef === right.endpointRef
  )
}
