import { PAIRING_ENDPOINT_MAX_CHARACTERS } from '../mobile-pairing-protocol-limits'

export function normalizePairingUrl(value: string): string | null {
  if (value.length > PAIRING_ENDPOINT_MAX_CHARACTERS || containsAsciiControlCharacter(value)) {
    return null
  }
  try {
    const endpoint = new URL(value)
    if (endpoint.protocol === 'http:') {
      endpoint.protocol = 'ws:'
    } else if (endpoint.protocol === 'https:') {
      endpoint.protocol = 'wss:'
    }
    if (
      (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') ||
      !endpoint.hostname ||
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      endpoint.port === '0' ||
      isPairingWildcardHostname(endpoint.hostname)
    ) {
      return null
    }
    const formatted = endpoint.toString()
    return endpoint.pathname === '/' && !endpoint.search ? formatted.replace(/\/$/, '') : formatted
  } catch {
    return null
  }
}

function containsAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (code <= 31 || code === 127) {
      return true
    }
  }
  return false
}

export function isPairingWildcardHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return (
    normalized === '*' ||
    normalized === '0.0.0.0' ||
    normalized === '::' ||
    normalized === '::ffff:0:0'
  )
}
