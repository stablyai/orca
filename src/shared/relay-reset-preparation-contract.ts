import {
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  parseRelayOwnerResetRequest,
  type RelayOwnerResetRequest
} from './relay-owner-reset-contract'

export const RELAY_RESET_PREPARATION_READ_FLAG = '--read-reset-preparation'

export type RelayResetPreparationBinding = Readonly<{
  version: 1
  journalDirectory: string
  readerVersion?: 1
  principal: string
  authenticationKind: 'launch-nonce' | 'endpoint-credential'
  sockPath: string
  serverBuildId: string
}>
export type RelayResetPreparationRecord = Readonly<
  Omit<RelayResetPreparationBinding, 'journalDirectory' | 'readerVersion'> & {
    prepared: true
    request: RelayOwnerResetRequest
  }
>

function parseIdentity(value: unknown) {
  const record = value as RelayResetPreparationBinding | null
  const text = (value: unknown) =>
    typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0')
  if (
    !record ||
    record.version !== 1 ||
    !text(record.principal) ||
    !text(record.sockPath) ||
    !text(record.serverBuildId) ||
    !['launch-nonce', 'endpoint-credential'].includes(record.authenticationKind)
  ) {
    throw new Error('relay_reset_preparation_journal_invalid')
  }
  return {
    version: 1 as const,
    principal: record.principal,
    authenticationKind: record.authenticationKind,
    sockPath: record.sockPath,
    serverBuildId: record.serverBuildId
  }
}

export function parseRelayResetPreparationBinding(value: unknown): RelayResetPreparationBinding {
  const identity = parseIdentity(value)
  const directory = (value as RelayResetPreparationBinding).journalDirectory
  const readerVersion = (value as RelayResetPreparationBinding).readerVersion
  if (
    typeof directory !== 'string' ||
    !directory ||
    directory.length > 8192 ||
    directory.includes('\0')
  ) {
    throw new Error('relay_reset_preparation_journal_invalid')
  }
  if (readerVersion !== undefined && readerVersion !== 1) {
    throw new Error('relay_reset_preparation_reader_version_invalid')
  }
  return Object.freeze({
    ...identity,
    journalDirectory: directory,
    ...(readerVersion === undefined ? {} : { readerVersion })
  })
}

export function parseRelayResetPreparationRecord(value: unknown): RelayResetPreparationRecord {
  const identity = parseIdentity(value)
  const record = value as RelayResetPreparationRecord
  if (record.prepared !== true) {
    throw new Error('relay_reset_preparation_journal_invalid')
  }
  return Object.freeze({
    version: 1,
    prepared: true,
    request: parseRelayOwnerResetRequest(record.request),
    principal: identity.principal,
    authenticationKind: identity.authenticationKind,
    sockPath: identity.sockPath,
    serverBuildId: identity.serverBuildId
  })
}

export function readRelayResetPreparationBinding(
  status: unknown
): RelayResetPreparationBinding | undefined {
  const value = status as { capabilities?: unknown; ownerReset?: { preparation?: unknown } } | null
  if (
    !Array.isArray(value?.capabilities) ||
    !value.capabilities.includes(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  ) {
    return undefined
  }
  return parseRelayResetPreparationBinding(value.ownerReset?.preparation)
}

export function validateRelayResetPreparationRecord(
  value: unknown,
  expectedBinding: RelayResetPreparationBinding,
  expectedRequest: RelayOwnerResetRequest
): RelayResetPreparationRecord {
  const record = parseRelayResetPreparationRecord(value)
  const binding = parseRelayResetPreparationBinding(expectedBinding)
  if (
    record.principal !== binding.principal ||
    record.authenticationKind !== binding.authenticationKind ||
    record.sockPath !== binding.sockPath ||
    record.serverBuildId !== binding.serverBuildId ||
    JSON.stringify(record.request) !== JSON.stringify(parseRelayOwnerResetRequest(expectedRequest))
  ) {
    throw new Error('relay_reset_preparation_journal_conflict')
  }
  return record
}
