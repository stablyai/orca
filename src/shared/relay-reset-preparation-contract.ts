import {
  RELAY_DURABLE_RESET_PREPARATION_CAPABILITY,
  parseRelayOwnerResetRequest,
  readRelayResetRecord,
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

function isJournalText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 8192 && !value.includes('\0')
  )
}

function isAuthenticationKind(
  value: unknown
): value is RelayResetPreparationBinding['authenticationKind'] {
  return value === 'launch-nonce' || value === 'endpoint-credential'
}

function parseIdentity(record: Record<string, unknown> | null) {
  const { principal, sockPath, serverBuildId, authenticationKind } = record ?? {}
  if (
    record?.version !== 1 ||
    !isJournalText(principal) ||
    !isJournalText(sockPath) ||
    !isJournalText(serverBuildId) ||
    !isAuthenticationKind(authenticationKind)
  ) {
    throw new Error('relay_reset_preparation_journal_invalid')
  }
  return { version: 1 as const, principal, authenticationKind, sockPath, serverBuildId }
}

export function parseRelayResetPreparationBinding(value: unknown): RelayResetPreparationBinding {
  const record = readRelayResetRecord(value)
  const identity = parseIdentity(record)
  const directory = record?.journalDirectory
  const readerVersion = record?.readerVersion
  if (!isJournalText(directory)) {
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
  const record = readRelayResetRecord(value)
  const identity = parseIdentity(record)
  if (record?.prepared !== true) {
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
  const value = readRelayResetRecord(status)
  const capabilities = value?.capabilities
  if (
    !Array.isArray(capabilities) ||
    !capabilities.includes(RELAY_DURABLE_RESET_PREPARATION_CAPABILITY)
  ) {
    return undefined
  }
  return parseRelayResetPreparationBinding(readRelayResetRecord(value?.ownerReset)?.preparation)
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
