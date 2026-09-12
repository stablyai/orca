import { parsePtyOwnershipCaptureBoundary } from './pty-ownership-capture-boundary'
import type { PtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'

export type PtyOwnershipCaptureBaseline = ReturnType<typeof parsePtyOwnershipCaptureBaseline>

/** A selected image identity is not a destination import receipt or an output ACK. */
export function parsePtyOwnershipCaptureBaseline(
  value: unknown,
  identity: PtyOwnershipTransferWireIdentity
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_ownership_capture_baseline_invalid')
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    typeof record.modelSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.modelSha256)
  ) {
    throw new Error('pty_ownership_capture_baseline_invalid')
  }
  return Object.freeze({
    version: 1 as const,
    boundary: parsePtyOwnershipCaptureBoundary(record.boundary, identity),
    modelSha256: record.modelSha256
  })
}
