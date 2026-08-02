import { parsePairingCode } from './pairing'
import {
  getEphemeralVmRecipeResultConnection,
  type EphemeralVmRecipeConnection,
  type EphemeralVmRecipeResult,
  type JsonValue
} from './ephemeral-vm-recipes'

export type EphemeralVmRecipeResultWarning = {
  id: string
  message: string
  remediation?: string
}

export function getEphemeralVmRecipeResultWarnings(
  result: EphemeralVmRecipeResult
): EphemeralVmRecipeResultWarning[] {
  const connection = getEphemeralVmRecipeResultConnection(result)
  if (connection.type !== 'orca-server') {
    return []
  }
  const pairing = parsePairingCode(connection.pairingCode)
  if (!pairing) {
    return []
  }
  const warnings: EphemeralVmRecipeResultWarning[] = []
  if (isPublicInsecureWebSocketEndpoint(pairing.endpoint)) {
    warnings.push({
      id: 'recipe.result.endpoint.public_ws',
      message: `Recipe pairing endpoint uses insecure public ws:// transport: ${pairing.endpoint}`,
      remediation: 'Use wss://, a private network, or an authenticated tunnel for public endpoints.'
    })
  }
  return warnings
}

export function redactEphemeralVmRecipeDiagnosticText(text: string): string {
  if (!text) {
    return text
  }
  return text
    .replace(/orca:\/\/pair\?code=[A-Za-z0-9_-]+/g, 'orca://pair?code=[redacted]')
    .replace(
      /("(?:pairingCode|deviceToken|publicKeyB64|token|secret|password|apiKey|accessToken|identityFile|identityAgent|proxyCommand)"\s*:\s*)"[^"]*"/gi,
      '$1"[redacted]"'
    )
}

export function redactEphemeralVmRecipeResultForDiagnostics(
  result: EphemeralVmRecipeResult
): EphemeralVmRecipeResult {
  const userData = result.userData ? redactJsonObject(result.userData) : undefined
  if ('connection' in result) {
    return {
      ...result,
      connection: redactConnection(result.connection),
      ...(userData ? { userData } : {})
    }
  }
  return {
    ...result,
    pairingCode: 'orca://pair?code=[redacted]',
    ...(userData ? { userData } : {})
  }
}

function redactConnection(connection: EphemeralVmRecipeConnection): EphemeralVmRecipeConnection {
  if (connection.type === 'orca-server') {
    return { ...connection, pairingCode: 'orca://pair?code=[redacted]' }
  }
  return {
    ...connection,
    target: {
      ...connection.target,
      ...(connection.target.identityFile ? { identityFile: '[redacted-path]' } : {}),
      ...(connection.target.identityAgent ? { identityAgent: '[redacted-path]' } : {}),
      ...(connection.target.proxyCommand ? { proxyCommand: '[redacted]' } : {})
    }
  }
}

function isPublicInsecureWebSocketEndpoint(endpoint: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    return false
  }
  if (parsed.protocol !== 'ws:') {
    return false
  }
  return !isLocalOrPrivateHostname(parsed.hostname)
}

function isLocalOrPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true
  }
  if (normalized === '::1' || normalized.startsWith('fe80:') || normalized.startsWith('fd')) {
    return true
  }
  const ipv4 = normalized.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!ipv4) {
    return false
  }
  const octets = ipv4.slice(1).map((part) => Number(part))
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [first = 0, second = 0] = octets
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  )
}

function redactJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key) ? '[redacted]' : redactJsonValue(entry)
    ])
  )
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue)
  }
  if (value && typeof value === 'object') {
    return redactJsonObject(value)
  }
  return value
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|api[-_]?key|access[-_]?key|private[-_]?key/i.test(key)
}
