import { normalizePairingUrl } from './pairing-url'

export type EndpointAuthHeaders = Record<string, string>

export type NormalizeEndpointAuthHeadersResult =
  | { ok: true; headers: EndpointAuthHeaders }
  | { ok: false; error: string }

const MAX_HEADERS = 8
const MAX_NAME_LENGTH = 128
// Bound each value before storing it in the OS keychain.
const MAX_VALUE_LENGTH = 1024
const MAX_INVALID_NAME_PREVIEW = 64
// RFC 9110 token: what a reverse proxy accepts as a header name on the wire.
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && HEADER_NAME_PATTERN.test(name)
}

function hasInvalidHeaderCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code >= 0x7f) {
      return true
    }
  }
  return false
}

function isValidValue(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VALUE_LENGTH && !hasInvalidHeaderCharacter(value)
}

export function normalizeEndpointAuthHeaders(rows: unknown): NormalizeEndpointAuthHeadersResult {
  if (!Array.isArray(rows)) {
    return { ok: false, error: 'Headers must be a list.' }
  }
  const headers: EndpointAuthHeaders = {}
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) {
      return { ok: false, error: 'Each header must be a name/value pair.' }
    }
    const rawName = 'name' in row ? row.name : undefined
    const rawValue = 'value' in row ? row.value : undefined
    const trimmedName = typeof rawName === 'string' ? rawName.trim() : ''
    const trimmedValue = typeof rawValue === 'string' ? rawValue.trim() : ''
    if (!trimmedName && !trimmedValue) {
      continue
    }
    if (!isValidName(trimmedName)) {
      return {
        ok: false,
        error: `Invalid header name: "${trimmedName.slice(0, MAX_INVALID_NAME_PREVIEW)}".`
      }
    }
    if (!isValidValue(trimmedValue)) {
      return { ok: false, error: `Invalid value for header "${trimmedName}".` }
    }
    const duplicate = Object.keys(headers).find(
      (existing) => existing.toLowerCase() === trimmedName.toLowerCase()
    )
    if (duplicate) {
      delete headers[duplicate]
    }
    // Treat every header name as data, including __proto__.
    Object.defineProperty(headers, trimmedName, {
      value: trimmedValue,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  if (Object.keys(headers).length > MAX_HEADERS) {
    return { ok: false, error: `At most ${MAX_HEADERS} headers are supported.` }
  }
  return { ok: true, headers }
}

export function endpointAuthOrigin(endpoint: string): string | null {
  const normalized = normalizePairingUrl(endpoint)
  return normalized?.startsWith('wss://') ? new URL(normalized).origin : null
}
