import type {
  PtySourceCreditAck,
  PtySourceDeliveryIdentity,
  PtySourceSpan
} from './pty-source-credit-contract'

export function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}

export function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
}

export function assertPtySourceIdentity(identity: PtySourceDeliveryIdentity): void {
  if (!identity.id || !identity.ptyIncarnation || !identity.deliveryToken) {
    throw new Error('PTY source delivery identity is incomplete')
  }
  assertPositiveSafeInteger(identity.providerGeneration, 'providerGeneration')
  assertPositiveSafeInteger(identity.clientGeneration, 'clientGeneration')
  assertPositiveSafeInteger(identity.ownerGeneration, 'ownerGeneration')
}

export function assertPtySourceSpan(span: PtySourceSpan): void {
  assertPtySourceIdentity(span)
  if (!span.spanId) {
    throw new Error('spanId is required')
  }
  assertNonNegativeSafeInteger(span.sourceStartSu, 'sourceStartSu')
  assertNonNegativeSafeInteger(span.sourceEndSu, 'sourceEndSu')
  assertNonNegativeSafeInteger(span.displayStart, 'displayStart')
  assertNonNegativeSafeInteger(span.displayEnd, 'displayEnd')
  assertNonNegativeSafeInteger(span.transform.rawLengthSu, 'rawLengthSu')
  if (span.sourceEndSu < span.sourceStartSu || span.displayEnd < span.displayStart) {
    throw new Error('PTY source span ranges must be ordered')
  }
  if (span.sourceEndSu - span.sourceStartSu !== span.transform.rawLengthSu) {
    throw new Error('PTY source span raw length does not match its source range')
  }
  if (!span.transform.transformed && span.data.length !== span.transform.rawLengthSu) {
    throw new Error('Untransformed PTY source span length is invalid')
  }
  if (
    span.splittable !== undefined &&
    span.indivisible !== undefined &&
    span.splittable === span.indivisible
  ) {
    throw new Error('PTY source span split metadata is contradictory')
  }
}

export function assertPtySourceAck(ack: PtySourceCreditAck): void {
  if (!ack.id || !ack.deliveryToken) {
    throw new Error('PTY source ACK identity is incomplete')
  }
  assertPositiveSafeInteger(ack.clientGeneration, 'clientGeneration')
  assertPositiveSafeInteger(ack.ownerGeneration, 'ownerGeneration')
  assertNonNegativeSafeInteger(ack.creditedEndSu, 'creditedEndSu')
}
