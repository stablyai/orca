import type { EnrichedDetectedPort, SshConnectionState, SshConnectionStatus } from './ssh-types'
import { clampUtf8TextPrefix, measureUtf8ByteLength } from './utf8-byte-limits'

export const SSH_RETAINED_IDENTIFIER_MAX_UTF8_BYTES = 1024
export const SSH_CONNECTION_ERROR_MAX_UTF8_BYTES = 16 * 1024
export const SSH_CREDENTIAL_DETAIL_MAX_UTF8_BYTES = 16 * 1024
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
  return {
    targetId: expectedTargetId,
    status: input.status as SshConnectionStatus,
    error,
    reconnectAttempt: input.reconnectAttempt,
    ...(isNonNegativeSafeInteger(input.connectionGeneration)
      ? { connectionGeneration: input.connectionGeneration }
      : {}),
    ...(typeof input.supportsFolderDownload === 'boolean'
      ? { supportsFolderDownload: input.supportsFolderDownload }
      : {}),
    ...(input.remotePlatform === 'linux' ||
    input.remotePlatform === 'darwin' ||
    input.remotePlatform === 'win32'
      ? { remotePlatform: input.remotePlatform }
      : {})
  }
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
