import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferWireIdentity
} from './pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from './pty-ownership-transfer-identity'

export type PtyOwnershipCaptureBoundary = ReturnType<typeof parsePtyOwnershipCaptureBoundary>

export function parsePtyOwnershipCaptureBoundary(
  value: unknown,
  expected: PtyOwnershipTransferWireIdentity
) {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !nonnegative(value.throughSeq) ||
    !isRecord(value.delivery)
  ) {
    throw new Error('pty_ownership_capture_boundary_invalid')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
  const delivery = value.delivery
  if (
    !samePtyOwnershipTransferIdentity(identity, expected) ||
    delivery.id !== identity.terminalId ||
    delivery.ptyIncarnation !== identity.incarnationId ||
    delivery.ownerGeneration !== identity.sourceOwnerGeneration ||
    !positive(delivery.providerGeneration) ||
    !positive(delivery.clientGeneration) ||
    !positive(delivery.ownerGeneration) ||
    !positive(delivery.windowSu) ||
    typeof delivery.deliveryToken !== 'string' ||
    !delivery.deliveryToken ||
    delivery.deliveryToken.length > 512 ||
    delivery.state !== 'active' ||
    delivery.generationClosed !== false ||
    delivery.exitPublished !== false ||
    !nonnegative(delivery.receivedEndSu) ||
    delivery.sentEndSu !== delivery.receivedEndSu ||
    delivery.creditedEndSu !== delivery.receivedEndSu
  ) {
    throw new Error('pty_ownership_capture_boundary_invalid')
  }
  return Object.freeze({
    version: 1 as const,
    identity: Object.freeze(identity),
    throughSeq: value.throughSeq,
    delivery: Object.freeze({
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
      providerGeneration: delivery.providerGeneration,
      clientGeneration: delivery.clientGeneration,
      ownerGeneration: delivery.ownerGeneration,
      deliveryToken: delivery.deliveryToken,
      state: 'active' as const,
      windowSu: delivery.windowSu,
      receivedEndSu: delivery.receivedEndSu,
      sentEndSu: delivery.receivedEndSu,
      creditedEndSu: delivery.receivedEndSu,
      generationClosed: false as const,
      exitPublished: false as const
    })
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function nonnegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
function positive(value: unknown): value is number {
  return nonnegative(value) && value > 0
}
