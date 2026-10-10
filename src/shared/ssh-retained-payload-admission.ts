import type {
  DirectSshAuthority,
  EnrichedDetectedPort,
  SshConnectionState,
  SshConnectionStatus,
  SshManagedServerStatus,
  SshManagedServerUpdateNote,
  SshPlainSshMode,
  SshProviderEpoch
} from './ssh-types'
import {
  SSH_MANAGED_SERVER_PHASES,
  SSH_MANAGED_SERVER_RELAY_REASONS,
  SSH_MANAGED_SERVER_UPDATE_STATES
} from './ssh-types'
import { clampUtf8TextPrefix, measureUtf8ByteLength } from './utf8-byte-limits'

export const SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES = 1024
export const SSH_CONNECTION_ERROR_MAX_UTF8_BYTES = 16 * 1024
export const SSH_PROVIDER_EPOCH_MAX_UTF8_BYTES = 128
const SSH_PLAIN_SSH_REASON_MAX_UTF8_BYTES = 64
export const SSH_DETECTED_PORTS_MAX_ENTRIES = 50
export const SSH_DETECTED_PORT_HOST_MAX_UTF8_BYTES = 1024
export const SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES = 4 * 1024
export const SSH_DETECTED_PORT_ADVERTISED_URL_MAX_UTF8_BYTES = 2048

const CONNECTION_STATUSES = new Set<SshConnectionStatus>([
  'disconnected',
  'connecting',
  'auth-failed',
  'deploying-relay',
  'connected',
  'reconnecting',
  'reconnection-failed',
  'error'
])

export function isSshRetainedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !measureUtf8ByteLength(value, {
      stopAfterBytes: SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES
    }).exceededLimit
  )
}

export function isAdmissibleDirectSshAuthority(value: unknown): value is DirectSshAuthority {
  if (!value || typeof value !== 'object') {
    return false
  }
  const authority = value as Record<string, unknown>
  return (
    isSshRetainedIdentifier(authority.targetId) &&
    isSshProviderEpoch(authority.providerEpoch) &&
    isNonNegativeSafeInteger(authority.connectionGeneration)
  )
}

export function admitSshConnectionState(
  value: unknown,
  expectedTargetId: string
): SshConnectionState | null {
  if (!value || typeof value !== 'object' || !isSshRetainedIdentifier(expectedTargetId)) {
    return null
  }
  const input = value as Record<string, unknown>
  if (
    (input.targetId !== undefined &&
      (!isSshRetainedIdentifier(input.targetId) || input.targetId !== expectedTargetId)) ||
    typeof input.status !== 'string' ||
    !CONNECTION_STATUSES.has(input.status as SshConnectionStatus) ||
    !isNonNegativeSafeInteger(input.reconnectAttempt) ||
    (input.error !== null && typeof input.error !== 'string')
  ) {
    return null
  }

  const error = clampSshConnectionError(input.error)
  const hasProviderEpoch = input.providerEpoch !== undefined && input.providerEpoch !== null
  const hasConnectionGeneration = input.connectionGeneration !== undefined
  if (
    hasProviderEpoch !== hasConnectionGeneration ||
    (hasProviderEpoch &&
      (!isSshProviderEpoch(input.providerEpoch) ||
        !isNonNegativeSafeInteger(input.connectionGeneration)))
  ) {
    return null
  }
  return {
    targetId: expectedTargetId,
    status: input.status as SshConnectionStatus,
    error,
    reconnectAttempt: input.reconnectAttempt,
    providerEpoch: hasProviderEpoch ? (input.providerEpoch as SshProviderEpoch) : null,
    ...(hasProviderEpoch ? { connectionGeneration: input.connectionGeneration as number } : {}),
    ...(typeof input.supportsFolderDownload === 'boolean'
      ? { supportsFolderDownload: input.supportsFolderDownload }
      : {}),
    ...(input.remotePlatform === 'linux' ||
    input.remotePlatform === 'darwin' ||
    input.remotePlatform === 'win32'
      ? { remotePlatform: input.remotePlatform }
      : {}),
    ...admitSshPlainSshMode(input.plainSsh),
    ...(input.hostNodeRuntime === true ? { hostNodeRuntime: true } : {}),
    ...admitSshManagedServerStatus(input.managedServer)
  }
}

// Why field-by-field like plainSsh: an unknown kind from a newer host drops alone.
function admitSshManagedServerStatus(value: unknown): { managedServer?: SshManagedServerStatus } {
  if (!value || typeof value !== 'object' || !('kind' in value)) {
    return {}
  }
  if (value.kind === 'managed' && 'environmentId' in value) {
    if (!isSshRetainedIdentifier(value.environmentId)) {
      return {}
    }
    const update = admitSshManagedServerUpdateNote('update' in value ? value.update : undefined)
    const serving =
      'serving' in value &&
      value.serving &&
      typeof value.serving === 'object' &&
      'state' in value.serving &&
      value.serving.state === 'unverifiable' &&
      'detail' in value.serving &&
      typeof value.serving.detail === 'string'
        ? {
            serving: {
              state: 'unverifiable' as const,
              detail: clampUtf8TextPrefix(value.serving.detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES)
            }
          }
        : {}
    return {
      managedServer: { kind: 'managed', environmentId: value.environmentId, ...update, ...serving }
    }
  }
  if (value.kind === 'setting-up' && 'phase' in value) {
    const phase = SSH_MANAGED_SERVER_PHASES.find((entry) => entry === value.phase)
    return phase ? { managedServer: { kind: 'setting-up', phase } } : {}
  }
  if (value.kind !== 'relay' || !('reason' in value)) {
    return {}
  }
  const reason = SSH_MANAGED_SERVER_RELAY_REASONS.find((entry) => entry === value.reason)
  if (!reason) {
    return {}
  }
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : ''
  const terminals = 'terminals' in value ? value.terminals : undefined
  return {
    managedServer: {
      kind: 'relay',
      reason,
      ...(detail
        ? { detail: clampUtf8TextPrefix(detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES) }
        : {}),
      ...(isNonNegativeSafeInteger(terminals) ? { terminals } : {}),
      ...('offerMove' in value && value.offerMove === true ? { offerMove: true } : {}),
      ...('terminalsElsewhere' in value && value.terminalsElsewhere === true
        ? { terminalsElsewhere: true }
        : {})
    }
  }
}

// Why alone: an unknown note from a newer host drops without hiding that the host is managed.
function admitSshManagedServerUpdateNote(value: unknown): { update?: SshManagedServerUpdateNote } {
  if (!value || typeof value !== 'object' || !('state' in value)) {
    return {}
  }
  const state = SSH_MANAGED_SERVER_UPDATE_STATES.find((entry) => entry === value.state)
  if (!state) {
    return {}
  }
  const detail = 'detail' in value && typeof value.detail === 'string' ? value.detail : ''
  return {
    update: {
      state,
      ...(detail
        ? { detail: clampUtf8TextPrefix(detail, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES) }
        : {})
    }
  }
}

// Why field-by-field: a malformed optional mode must drop alone, never the whole state.
function admitSshPlainSshMode(value: unknown): { plainSsh?: SshPlainSshMode } {
  if (!value || typeof value !== 'object') {
    return {}
  }
  const reason = 'reason' in value ? value.reason : undefined
  const message = 'message' in value ? value.message : undefined
  if (typeof reason !== 'string' || typeof message !== 'string' || !reason || !message) {
    return {}
  }
  return {
    plainSsh: {
      reason: clampUtf8TextPrefix(reason, SSH_PLAIN_SSH_REASON_MAX_UTF8_BYTES),
      message: clampUtf8TextPrefix(message, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES)
    }
  }
}

export function admitSshConnectionStateForAuthorityReconciliation(
  value: unknown,
  expectedTargetId: string
): SshConnectionState | null {
  const admitted = admitSshConnectionState(value, expectedTargetId)
  if (admitted || !value || typeof value !== 'object') {
    return admitted
  }
  const input = value as Record<string, unknown>
  const hasProviderEpoch = input.providerEpoch !== undefined && input.providerEpoch !== null
  const hasConnectionGeneration = input.connectionGeneration !== undefined
  if (hasProviderEpoch === hasConnectionGeneration) {
    return null
  }
  return admitSshConnectionState(
    {
      targetId: input.targetId,
      status: input.status,
      error: input.error,
      reconnectAttempt: input.reconnectAttempt,
      supportsFolderDownload: input.supportsFolderDownload,
      remotePlatform: input.remotePlatform,
      plainSsh: input.plainSsh,
      hostNodeRuntime: input.hostNodeRuntime,
      managedServer: input.managedServer
    },
    expectedTargetId
  )
}

function isSshProviderEpoch(value: unknown): value is SshProviderEpoch {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !measureUtf8ByteLength(value, {
      stopAfterBytes: SSH_PROVIDER_EPOCH_MAX_UTF8_BYTES
    }).exceededLimit
  )
}

export function clampSshConnectionError(error: string | null): string | null {
  return typeof error === 'string'
    ? clampUtf8TextPrefix(error, SSH_CONNECTION_ERROR_MAX_UTF8_BYTES)
    : null
}

export function admitSshDetectedPorts(value: unknown): EnrichedDetectedPort[] {
  if (!Array.isArray(value)) {
    return []
  }
  const retained: EnrichedDetectedPort[] = []
  const scanLimit = Math.min(value.length, SSH_DETECTED_PORTS_MAX_ENTRIES)
  for (let index = 0; index < scanLimit; index += 1) {
    const port = admitDetectedPort(value[index])
    if (port) {
      retained.push(port)
    }
  }
  return retained
}

function admitDetectedPort(value: unknown): EnrichedDetectedPort | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const input = value as Record<string, unknown>
  if (
    !Number.isSafeInteger(input.port) ||
    (input.port as number) < 1 ||
    (input.port as number) > 65_535 ||
    !isStringWithinLimit(input.host, SSH_DETECTED_PORT_HOST_MAX_UTF8_BYTES)
  ) {
    return null
  }
  const processName =
    typeof input.processName === 'string'
      ? clampUtf8TextPrefix(input.processName, SSH_DETECTED_PORT_PROCESS_NAME_MAX_UTF8_BYTES)
      : undefined
  const advertisedUrl = isStringWithinLimit(
    input.advertisedUrl,
    SSH_DETECTED_PORT_ADVERTISED_URL_MAX_UTF8_BYTES
  )
    ? input.advertisedUrl
    : undefined
  return {
    port: input.port as number,
    host: input.host,
    ...(isNonNegativeSafeInteger(input.pid) && input.pid > 0 ? { pid: input.pid } : {}),
    ...(processName ? { processName } : {}),
    ...(advertisedUrl ? { advertisedUrl } : {}),
    ...(input.advertisedProtocol === 'http' || input.advertisedProtocol === 'https'
      ? { advertisedProtocol: input.advertisedProtocol }
      : {})
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isStringWithinLimit(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
  )
}
