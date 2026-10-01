export const RELAY_OWNER_RESET_CAPABILITY = 'relay.ownerReset.v1'
export const RELAY_DURABLE_RESET_PREPARATION_CAPABILITY = 'relay.durableResetPreparation.v1'
export const RELAY_OWNER_RESET_METHOD = 'relay.reset'
export const RELAY_PREPARED_RESET_RECOVERY_METHOD = 'relay.recoverPreparedReset'

export type RelayOwnerResetRequest = Readonly<{
  version: 1
  operationId: string
  runtimeIncarnation: string
  ownerGeneration: number
  ownerLease: string
}>

export type RelayOwnerResetAcknowledgment = {
  version: 1
  operationId: string
  runtimeIncarnation: string
  prepared: true
}

/** A wire value as a plain record; anything else reads as absent. */
export function readRelayResetRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? { ...value } : null
}

function isBoundedText(field: unknown, max: number): field is string {
  return typeof field === 'string' && field.length > 0 && field.length <= max
}

export function parseRelayOwnerResetRequest(value: unknown): RelayOwnerResetRequest {
  const record = readRelayResetRecord(value)
  const operationId = record?.operationId
  const runtimeIncarnation = record?.runtimeIncarnation
  const ownerGeneration = record?.ownerGeneration
  const ownerLease = record?.ownerLease
  if (
    record?.version !== 1 ||
    !isBoundedText(operationId, 128) ||
    !isBoundedText(runtimeIncarnation, 128) ||
    typeof ownerGeneration !== 'number' ||
    !Number.isSafeInteger(ownerGeneration) ||
    ownerGeneration < 1 ||
    !isBoundedText(ownerLease, 1024)
  ) {
    throw new Error('relay_reset_invalid_request')
  }
  return Object.freeze({
    version: 1,
    operationId,
    runtimeIncarnation,
    ownerGeneration,
    ownerLease
  })
}

export function readRelayOwnerResetIncarnation(status: unknown): string {
  const value = readRelayResetRecord(status)
  const capabilities = value?.capabilities
  const ownerReset = readRelayResetRecord(value?.ownerReset)
  const incarnation = ownerReset?.runtimeIncarnation
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(RELAY_OWNER_RESET_CAPABILITY) ||
    ownerReset?.version !== 1 ||
    typeof incarnation !== 'string' ||
    incarnation.length === 0 ||
    incarnation.length > 128
  ) {
    throw new Error('relay_reset_capability_unavailable')
  }
  return incarnation
}

export function parseRelayOwnerResetAcknowledgment(
  value: unknown,
  expected: RelayOwnerResetRequest
): RelayOwnerResetAcknowledgment {
  const result = readRelayResetRecord(value)
  if (
    !result ||
    result.version !== 1 ||
    result.prepared !== true ||
    result.operationId !== expected.operationId ||
    result.runtimeIncarnation !== expected.runtimeIncarnation
  ) {
    throw new Error('relay_reset_acknowledgment_invalid')
  }
  return {
    version: 1,
    operationId: expected.operationId,
    runtimeIncarnation: expected.runtimeIncarnation,
    prepared: true
  }
}
