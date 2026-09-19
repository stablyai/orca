import type { OrcadMigrationManifest } from './orcad-migration-manifest'
import type { parseOrcadMigrationLiveTerminalBindings } from './orcad-migration-live-terminal-bindings'
import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferPublicationReceipt } from './pty-ownership-transfer-receipt-wire'
import { samePtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

/** Structural receipt binding only; callers must authenticate destination observations. */
export function parseOrcadMigrationTerminalPublications(
  value: unknown,
  manifest: OrcadMigrationManifest,
  bindings: ReturnType<typeof parseOrcadMigrationLiveTerminalBindings>,
  requireComplete: boolean
) {
  if (
    !Array.isArray(value) ||
    value.length > bindings.length ||
    (requireComplete && value.length !== bindings.length)
  ) {
    throw new Error('orcad_migration_live_cutover_completion_evidence_required')
  }
  const bridges = new Set<string>()
  const receipts = new Set<string>()
  return value.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('orcad_migration_terminal_publication_invalid')
    }
    const record = raw as Record<string, unknown>
    const identity = parsePtyOwnershipTransferWireIdentity(record.identity)
    const receipt = parsePtyOwnershipTransferPublicationReceipt(record.publicationReceipt)
    const catalog = record.catalog as Record<string, unknown> | null | undefined
    const binding = bindings.find((entry) =>
      samePtyOwnershipTransferIdentity(entry.identity, identity)
    )
    if (
      !binding ||
      bridges.has(identity.bridgeId) ||
      receipts.has(receipt.publicationReceiptId) ||
      receipt.bridgeId !== identity.bridgeId ||
      receipt.commitReceipt.bridgeId !== identity.bridgeId ||
      receipt.destinationRuntimeId !== identity.destinationRuntimeId ||
      !receipt.surfaceBinding ||
      !samePtyOwnershipTransferSurfaceBinding(receipt.surfaceBinding, binding.surfaceBinding) ||
      catalog?.migrationId !== manifest.migrationId ||
      catalog.manifestSha256 !== manifest.manifestSha256
    ) {
      throw new Error('orcad_migration_terminal_publication_conflict')
    }
    bridges.add(identity.bridgeId)
    receipts.add(receipt.publicationReceiptId)
    return {
      identity,
      publicationReceipt: receipt,
      catalog: { migrationId: manifest.migrationId, manifestSha256: manifest.manifestSha256 }
    }
  })
}
