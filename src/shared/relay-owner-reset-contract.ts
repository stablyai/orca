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

export function parseRelayOwnerResetRequest(value: unknown): RelayOwnerResetRequest {
  const record = value as Partial<RelayOwnerResetRequest> | null
  const bounded = (field: unknown, max: number) =>
    typeof field === 'string' && field.length > 0 && field.length <= max
  if (
    !record ||
    record.version !== 1 ||
    !bounded(record.operationId, 128) ||
    !bounded(record.runtimeIncarnation, 128) ||
    !Number.isSafeInteger(record.ownerGeneration) ||
    record.ownerGeneration! < 1 ||
    !bounded(record.ownerLease, 1024)
  ) {
    throw new Error('relay_reset_invalid_request')
  }
  return Object.freeze({
    version: 1,
    operationId: record.operationId!,
    runtimeIncarnation: record.runtimeIncarnation!,
    ownerGeneration: record.ownerGeneration!,
    ownerLease: record.ownerLease!
  })
}

export function readRelayOwnerResetIncarnation(status: unknown): string {
  const value = status as {
    capabilities?: unknown
    ownerReset?: { version?: unknown; runtimeIncarnation?: unknown }
  } | null
  const incarnation = value?.ownerReset?.runtimeIncarnation
  if (
    !Array.isArray(value?.capabilities) ||
    !value.capabilities.includes(RELAY_OWNER_RESET_CAPABILITY) ||
    value.ownerReset?.version !== 1 ||
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
  const result = value as Partial<RelayOwnerResetAcknowledgment> | null
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
