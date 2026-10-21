import type { PtySourceDeliveryIdentity } from './pty-source-credit-contract'

function assertPositiveSafeInteger(value: number, name: string): void {
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
