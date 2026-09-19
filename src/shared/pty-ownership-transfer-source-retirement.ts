import { parsePtyOwnershipTransferDestinationInspectionRequest } from './pty-ownership-transfer-destination-claim'
import { parsePtyOwnershipTransferWireIdentity } from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'
import { parsePtyOwnershipCaptureBoundary } from './pty-ownership-capture-boundary'

export const PTY_OWNERSHIP_TRANSFER_SOURCE_RETIREMENT_METHOD =
  'pty.ownershipTransfer.retireSourceDelivery'

export function parsePtyOwnershipTransferSourceRetirementRequest(value: unknown) {
  const proof = parsePtyOwnershipTransferDestinationInspectionRequest(value)
  const hash = (value as Record<string, unknown>).retirementRecordSha256
  const recoveryOnly = (value as Record<string, unknown>).recoveryOnly
  if (recoveryOnly !== undefined && typeof recoveryOnly !== 'boolean') {
    throw new Error('pty_source_retirement_request_invalid')
  }
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('pty_source_retirement_request_invalid')
  }
  const expected = (value as Record<string, unknown>).expectedDelivery
  const expectedDelivery =
    expected === undefined
      ? undefined
      : parsePtyOwnershipCaptureBoundary(
          { version: 1, identity: proof, throughSeq: 0, delivery: expected },
          proof
        ).delivery
  return Object.freeze({
    ...proof,
    retirementRecordSha256: hash,
    ...(recoveryOnly === undefined ? {} : { recoveryOnly }),
    ...(expectedDelivery ? { expectedDelivery } : {})
  })
}

export function parsePtyOwnershipTransferSourceRetirementResult(
  value: unknown,
  requestValue: unknown,
  expectedDeliveryValue: unknown
) {
  const request = parsePtyOwnershipTransferSourceRetirementRequest(requestValue)
  const result = parsePtyOwnershipTransferSourceRetirementEvidence(value)
  const expected = parsePtyOwnershipCaptureBoundary(
    { version: 1, identity: request, throughSeq: 0, delivery: expectedDeliveryValue },
    request
  ).delivery
  if (
    !samePtyOwnershipTransferIdentity(result, request) ||
    result.sourceDeliveryRetirement.retirementRecordSha256 !== request.retirementRecordSha256
  ) {
    throw new Error('pty_source_retirement_response_mismatch')
  }
  if (JSON.stringify(result.sourceDeliveryRetirement.delivery) !== JSON.stringify(expected)) {
    throw new Error('pty_source_retirement_delivery_mismatch')
  }
  return result
}

/** Parses historical evidence only; transport authentication and current claims remain caller-owned. */
export function parsePtyOwnershipTransferSourceRetirementEvidence(value: unknown) {
  const identity = parsePtyOwnershipTransferWireIdentity(value)
  const record = value as Record<string, unknown>
  const retirement = record.sourceDeliveryRetirement as Record<string, unknown> | null
  if (
    record.version !== 1 ||
    !retirement ||
    retirement.phase !== 'retired' ||
    typeof retirement.retirementRecordSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(retirement.retirementRecordSha256)
  ) {
    throw new Error('pty_source_retirement_response_mismatch')
  }
  const parseDelivery = (delivery: unknown) =>
    parsePtyOwnershipCaptureBoundary(
      {
        version: 1,
        identity,
        throughSeq: 0,
        delivery
      },
      identity
    ).delivery
  const delivery = parseDelivery(retirement.delivery)
  const cancellation = record.sourceCancellation as Record<string, unknown> | undefined
  if (
    cancellation !== undefined &&
    (!cancellation ||
      Array.isArray(cancellation) ||
      cancellation.canceled !== true ||
      cancellation.sentEndSu !== delivery.sentEndSu ||
      cancellation.creditedEndSu !== delivery.creditedEndSu)
  ) {
    throw new Error('pty_source_retirement_cancellation_mismatch')
  }
  return Object.freeze({
    ...identity,
    version: 1 as const,
    ...(cancellation === undefined
      ? {}
      : {
          sourceCancellation: Object.freeze({
            canceled: true as const,
            sentEndSu: delivery.sentEndSu,
            creditedEndSu: delivery.creditedEndSu
          })
        }),
    sourceDeliveryRetirement: Object.freeze({
      phase: 'retired' as const,
      retirementRecordSha256: retirement.retirementRecordSha256,
      delivery
    })
  })
}
