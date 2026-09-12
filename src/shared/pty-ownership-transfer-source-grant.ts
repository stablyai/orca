import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from './pty-ownership-transfer-surface-binding'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'

export const PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION = 1 as const

export type PtyOwnershipTransferSourceGrantRequest = Readonly<{
  version: typeof PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION
  terminalId: string
  destinationRuntimeId: string
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
}>

export type PtyOwnershipTransferSourceGrant = Readonly<{
  version: typeof PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
}>

export function parsePtyOwnershipTransferSourceGrantRequest(
  value: unknown
): PtyOwnershipTransferSourceGrantRequest {
  const record = requireRecord(value)
  if (record.version !== PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION) {
    throw invalidGrant()
  }
  return Object.freeze({
    version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
    terminalId: requiredString(record.terminalId),
    destinationRuntimeId: requiredString(record.destinationRuntimeId),
    surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(record.surfaceBinding)
  })
}

export function parsePtyOwnershipTransferSourceGrant(
  value: unknown
): PtyOwnershipTransferSourceGrant {
  const record = requireRecord(value)
  if (record.version !== PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION) {
    throw invalidGrant()
  }
  return Object.freeze({
    version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
    identity: Object.freeze(parsePtyOwnershipTransferWireIdentity(record.identity)),
    surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(record.surfaceBinding)
  })
}

export function samePtyOwnershipTransferSourceGrant(
  left: PtyOwnershipTransferSourceGrant,
  right: PtyOwnershipTransferSourceGrant
): boolean {
  return (
    samePtyOwnershipTransferIdentity(left.identity, right.identity) &&
    samePtyOwnershipTransferSurfaceBinding(left.surfaceBinding, right.surfaceBinding)
  )
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidGrant()
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 4_096) {
    throw invalidGrant()
  }
  return value
}

function invalidGrant(): Error {
  return new Error('pty_ownership_transfer_source_grant_invalid')
}
