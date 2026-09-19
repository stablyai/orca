import { z } from 'zod'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'

export const PTY_OWNERSHIP_SOURCE_ENDPOINT_METHOD = 'pty.ownershipTransfer.sourceEndpoint'
const endpoint = z.object({
  version: z.literal(1),
  endpoint: z.string().min(1).max(4096),
  incumbentVersion: z.string().min(1).max(256),
  endpointCredential: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/)
})

export function parsePtyOwnershipSourceEndpoint(
  value: unknown,
  expected: PtyOwnershipTransferWireIdentity
) {
  const result = endpoint.parse(value)
  const identity = parsePtyOwnershipTransferWireIdentity(
    (value as Record<string, unknown>).identity
  )
  if (
    !samePtyOwnershipTransferIdentity(identity, expected) ||
    result.endpoint.includes('\0') ||
    !result.endpoint.trim()
  ) {
    throw new Error('pty_ownership_source_endpoint_invalid')
  }
  return { ...result, identity }
}
