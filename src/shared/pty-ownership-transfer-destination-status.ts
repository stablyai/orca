import {
  parsePtyOwnershipTransferWireIdentity,
  parsePtyOwnershipTransferCommitReceipt
} from './pty-ownership-transfer-wire'
import { parsePtyOwnershipTransferDestinationClaim } from './pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferExit } from './pty-ownership-transfer-control-wire'
import { parsePtyOwnershipTransferTerminalInfo } from './pty-ownership-transfer-terminal-info'
import { parsePtyOwnershipCaptureBaseline } from './pty-ownership-capture-baseline'
import { parseOptionalPtyOwnershipTransferSurfacePublication } from './pty-ownership-transfer-surface-publication'

export function parsePtyOwnershipTransferDestinationClaimResult(value: unknown) {
  const record = versionedRecord(value)
  const claim = parsePtyOwnershipTransferDestinationClaim({
    generation: record.destinationGeneration,
    claimId: record.claimId
  })
  return Object.freeze({
    ...parsePtyOwnershipTransferWireIdentity(record),
    version: 1 as const,
    destinationGeneration: claim.generation,
    claimId: claim.claimId
  })
}

export function parsePtyOwnershipTransferDestinationStatus(value: unknown) {
  const record = versionedRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record)
  if (record.phase !== 'prepared' && record.phase !== 'committed' && record.phase !== 'aborted') {
    throw new Error('pty_ownership_transfer_destination_status_phase_invalid')
  }
  if (typeof record.boundToConnection !== 'boolean') {
    throw new Error('pty_ownership_transfer_destination_status_binding_invalid')
  }
  const claim =
    record.destinationClaim === null
      ? null
      : parsePtyOwnershipTransferDestinationClaim(record.destinationClaim)
  if (record.boundToConnection && (!claim || record.phase === 'aborted')) {
    throw new Error('pty_ownership_transfer_destination_status_binding_invalid')
  }
  const receipt =
    record.receipt === undefined
      ? undefined
      : parsePtyOwnershipTransferCommitReceipt(record.receipt)
  if (
    (record.phase === 'committed') !== Boolean(receipt) ||
    (record.phase === 'committed' && !claim) ||
    (receipt && receipt.bridgeId !== identity.bridgeId)
  ) {
    throw new Error('pty_ownership_transfer_destination_status_receipt_invalid')
  }
  const verdict = record.executionVerdict
  if (
    verdict !== undefined &&
    verdict !== 'live' &&
    verdict !== 'unverifiable' &&
    verdict !== 'exited'
  ) {
    throw new Error('pty_ownership_transfer_destination_status_verdict_invalid')
  }
  const exit = record.exit === undefined ? undefined : parsePtyOwnershipTransferExit(record.exit)
  if ((verdict === 'exited') !== Boolean(exit)) {
    throw new Error('pty_ownership_transfer_destination_status_exit_invalid')
  }
  const sourceOutputEndSeq = optionalSequence(record.sourceOutputEndSeq)
  const destinationAcknowledgedSeq = optionalSequence(record.destinationAcknowledgedSeq)
  if (
    destinationAcknowledgedSeq !== undefined &&
    sourceOutputEndSeq !== undefined &&
    destinationAcknowledgedSeq > sourceOutputEndSeq
  ) {
    throw new Error('pty_ownership_transfer_destination_status_cursor_invalid')
  }
  const inputEpoch = optionalSequence(record.inputEpoch)
  const surfacePublication = parseOptionalPtyOwnershipTransferSurfacePublication(
    record.surfacePublication
  )
  const captureBaseline =
    record.captureBaseline === undefined
      ? undefined
      : parsePtyOwnershipCaptureBaseline(record.captureBaseline, identity)
  if (
    captureBaseline &&
    (sourceOutputEndSeq === undefined ||
      captureBaseline.boundary.throughSeq > sourceOutputEndSeq ||
      (receipt && receipt.acceptedSourceEndSeq !== captureBaseline.boundary.throughSeq))
  ) {
    throw new Error('pty_ownership_transfer_destination_status_capture_invalid')
  }
  if (record.terminalInfo !== undefined && (!record.boundToConnection || verdict !== 'live')) {
    throw new Error('pty_ownership_transfer_terminal_info_unverifiable')
  }
  if (
    receipt &&
    sourceOutputEndSeq !== undefined &&
    receipt.acceptedSourceEndSeq > sourceOutputEndSeq
  ) {
    throw new Error('pty_ownership_transfer_destination_status_cursor_invalid')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    phase: record.phase,
    destinationClaim: claim,
    boundToConnection: record.boundToConnection,
    ...(receipt ? { receipt } : {}),
    ...(exit ? { exit } : {}),
    ...(verdict === undefined ? {} : { executionVerdict: verdict }),
    ...(sourceOutputEndSeq === undefined ? {} : { sourceOutputEndSeq }),
    ...(destinationAcknowledgedSeq === undefined ? {} : { destinationAcknowledgedSeq }),
    ...(inputEpoch === undefined ? {} : { inputEpoch }),
    ...(captureBaseline ? { captureBaseline } : {}),
    ...(surfacePublication ? { surfacePublication } : {}),
    ...(record.captureImportAckVersion === 1 ? { captureImportAckVersion: 1 as const } : {}),
    ...(record.sourceRetirementVersion === 1 ? { sourceRetirementVersion: 1 as const } : {}),
    ...(record.sourceRetirementVersion === 1 && record.sourceRetirementBoundaryVersion === 1
      ? { sourceRetirementBoundaryVersion: 1 as const }
      : {}),
    ...(record.sourceRetirementVersion === 1 &&
    record.sourceRetirementBoundaryVersion === 1 &&
    record.sourceRetirementRecoveryVersion === 1
      ? { sourceRetirementRecoveryVersion: 1 as const }
      : {}),
    ...(record.terminalInfo === undefined
      ? {}
      : { terminalInfo: parsePtyOwnershipTransferTerminalInfo(record.terminalInfo) })
  })
}

function versionedRecord(value: unknown): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1
  ) {
    throw new Error('pty_ownership_transfer_destination_status_invalid')
  }
  return value as Record<string, unknown>
}

function optionalSequence(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined
  }
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_destination_status_cursor_invalid')
  }
  return Number(value)
}
