import {
  parsePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from './pty-ownership-transfer-surface-binding'

export const PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION = 1 as const

export type PtyOwnershipTransferSurfacePublication = Readonly<{
  version: typeof PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
}>

export function parseOptionalPtyOwnershipTransferSurfacePublication(
  value: unknown
): PtyOwnershipTransferSurfacePublication | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!isRecord(value)) {
    throw new Error('pty_ownership_transfer_surface_publication_invalid')
  }
  if (value.version !== PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION) {
    throw new Error('pty_ownership_transfer_surface_publication_version_unsupported')
  }
  return Object.freeze({
    version: PTY_OWNERSHIP_TRANSFER_SURFACE_PUBLICATION_VERSION,
    surfaceBinding: parsePtyOwnershipTransferSurfaceBinding(value.surfaceBinding)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
