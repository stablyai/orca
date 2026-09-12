import type { PtyOwnershipTransferSurfacePublication } from './pty-ownership-transfer-surface-publication'

/** The destination persists its random capability before the source records this digest. */
export type PtyOwnershipTransferDestinationDelegation = Readonly<{
  version: 1
  credentialSha256: string
}>

export function parseOptionalPtyOwnershipTransferDestinationDelegation(
  value: unknown,
  surfacePublication: PtyOwnershipTransferSurfacePublication | undefined
): PtyOwnershipTransferDestinationDelegation | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_destination_delegation_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.credentialSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.credentialSha256)
  ) {
    throw new Error('pty_ownership_transfer_destination_delegation_invalid')
  }
  if (surfacePublication?.surfaceBinding.executionHostId !== 'local') {
    throw new Error('pty_ownership_transfer_delegation_requires_host_local_surface')
  }
  return Object.freeze({ version: 1, credentialSha256: record.credentialSha256 })
}
