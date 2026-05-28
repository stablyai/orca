const PAIRING_OFFER_VERSION = 2

export type WebPairingOffer = {
  v: typeof PAIRING_OFFER_VERSION
  endpoint: string
  deviceToken: string
  publicKeyB64: string
}

export function parseWebPairingInput(input: string): WebPairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  try {
    if (trimmed.startsWith('orca://pair')) {
      const hashIndex = trimmed.indexOf('#')
      if (hashIndex === -1) {
        return null
      }
      return decodePairingPayload(trimmed.slice(hashIndex + 1))
    }
    return decodePairingPayload(trimmed)
  } catch {
    return null
  }
}

export function readPairingInputFromLocation(location: Location): string | null {
  const search = new URLSearchParams(location.search)
  for (const key of ['pairing', 'pair', 'code', 'token']) {
    const value = search.get(key)
    if (value?.trim()) {
      return value.trim()
    }
  }

  const hash = location.hash.replace(/^#/, '').trim()
  if (!hash) {
    return null
  }
  if (hash.startsWith('orca://pair')) {
    return hash
  }
  const hashParams = new URLSearchParams(hash)
  for (const key of ['pairing', 'pair', 'code', 'token']) {
    const value = hashParams.get(key)
    if (value?.trim()) {
      return value.trim()
    }
  }
  return hash
}

export function clearPairingInputFromAddressBar(): void {
  if (!window.location.hash && !window.location.search) {
    return
  }
  const cleanUrl = `${window.location.origin}${window.location.pathname}`
  // Why: pairing payloads include the runtime auth token. Clear them after
  // import so refresh/share/browser history no longer expose the secret.
  window.history.replaceState(null, document.title, cleanUrl)
}

function decodePairingPayload(base64url: string): WebPairingOffer | null {
  const json = new TextDecoder().decode(base64UrlToBytes(base64url))
  const parsed = JSON.parse(json) as Partial<WebPairingOffer>
  if (
    parsed.v !== PAIRING_OFFER_VERSION ||
    typeof parsed.endpoint !== 'string' ||
    parsed.endpoint.length === 0 ||
    typeof parsed.deviceToken !== 'string' ||
    parsed.deviceToken.length === 0 ||
    typeof parsed.publicKeyB64 !== 'string' ||
    parsed.publicKeyB64.length === 0
  ) {
    return null
  }
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: normalizeWebSocketEndpoint(parsed.endpoint),
    deviceToken: parsed.deviceToken,
    publicKeyB64: parsed.publicKeyB64
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = window.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function normalizeWebSocketEndpoint(endpoint: string): string {
  if (endpoint.startsWith('http://')) {
    return `ws://${endpoint.slice('http://'.length)}`
  }
  if (endpoint.startsWith('https://')) {
    return `wss://${endpoint.slice('https://'.length)}`
  }
  return endpoint
}
