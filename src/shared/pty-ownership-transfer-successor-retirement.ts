import { parsePtyOwnershipCaptureBaseline } from './pty-ownership-capture-baseline'
import {
  parsePtyOwnershipTransferWireIdentity,
  parsePtyOwnershipTransferCommitReceipt
} from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'
import { parsePtyRetainedSourceDelivery } from './pty-retained-source-delivery'

export const PTY_OWNERSHIP_TRANSFER_SUCCESSOR_RETIREMENT_METHOD =
  'pty.ownershipTransfer.retireSuccessorSourceDelivery'

export function parsePtyOwnershipTransferSuccessorRetirementRequest(value: unknown) {
  const record = requireRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record)
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.successorGeneration) ||
    Number(record.successorGeneration) <= identity.sourceOwnerGeneration ||
    typeof record.retirementRecordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.retirementRecordSha256) ||
    typeof record.recoveryOnly !== 'boolean'
  ) {
    throw new Error('pty_successor_retirement_request_invalid')
  }
  return Object.freeze({
    version: 1 as const,
    ...identity,
    savedBaseline: parsePtyOwnershipCaptureBaseline(record.savedBaseline, identity),
    successorGeneration: Number(record.successorGeneration),
    retirementRecordSha256: record.retirementRecordSha256,
    recoveryOnly: record.recoveryOnly
  })
}

/** Authenticated host evidence, not independent proof of destination model application. */
export function parsePtyOwnershipTransferSuccessorRetirementResult(
  value: unknown,
  requestValue: unknown
) {
  const request = parsePtyOwnershipTransferSuccessorRetirementRequest(requestValue)
  const record = requireRecord(value)
  const identity = parsePtyOwnershipTransferWireIdentity(record)
  const retirement = requireRecord(record.coveredSourceDeliveryRetirement)
  const cancellation = requireRecord(record.sourceCancellation)
  const receipt = parsePtyOwnershipTransferCommitReceipt(retirement.receipt)
  const delivery = parsePtyRetainedSourceDelivery(
    retirement.delivery,
    request.savedBaseline.boundary.delivery
  )
  if (
    record.version !== 1 ||
    record.sourceDeliveryRetirement !== undefined ||
    !samePtyOwnershipTransferIdentity(identity, request) ||
    retirement.phase !== 'retired' ||
    retirement.retirementRecordSha256 !== request.retirementRecordSha256 ||
    retirement.modelSha256 !== request.savedBaseline.modelSha256 ||
    !Number.isSafeInteger(retirement.sourceOutputEndSeq) ||
    Number(retirement.sourceOutputEndSeq) < request.savedBaseline.boundary.throughSeq ||
    receipt.bridgeId !== request.bridgeId ||
    receipt.acceptedSourceEndSeq !== request.savedBaseline.boundary.throughSeq ||
    cancellation.canceled !== true ||
    cancellation.sentEndSu !== delivery.sentEndSu ||
    cancellation.creditedEndSu !== delivery.creditedEndSu
  ) {
    throw new Error('pty_successor_retirement_response_mismatch')
  }
  return Object.freeze({
    version: 1 as const,
    ...identity,
    coveredSourceDeliveryRetirement: Object.freeze({
      phase: 'retired' as const,
      retirementRecordSha256: request.retirementRecordSha256,
      modelSha256: request.savedBaseline.modelSha256,
      sourceOutputEndSeq: Number(retirement.sourceOutputEndSeq),
      receipt: Object.freeze(receipt),
      delivery
    }),
    sourceCancellation: Object.freeze({
      canceled: true as const,
      sentEndSu: delivery.sentEndSu,
      creditedEndSu: delivery.creditedEndSu
    })
  })
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pty_successor_retirement_record_invalid')
  }
  return value as Record<string, unknown>
}
