import type { DeviceScope } from '../../../shared/runtime-types'

const PAIRING_OFFER_VERSION = 2

export type WebPairingOffer = {
  v: typeof PAIRING_OFFER_VERSION
  endpoint: string
  deviceToken: string
  publicKeyB64: string
  scope?: DeviceScope
}

export type WebPairingStartupDecision =
  | { kind: 'auto-save-runtime-offer'; offer: WebPairingOffer }
  | { kind: 'show-connect'; initialPairingInput: string | null }
  | { kind: 'use-stored-environment' }

export function parseWebPairingInput(input: string): WebPairingOffer | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  try {
    if (trimmed.toLowerCase().startsWith('orca://')) {
      const code = extractPairingCodeFromUrl(trimmed)
      return code ? decodePairingPayload(code) : null
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

export function decideWebPairingStartup(args: {
  initialPairingInput: string | null
  hasStoredEnvironment: boolean
}): WebPairingStartupDecision {
  const offer = args.initialPairingInput ? parseWebPairingInput(args.initialPairingInput) : null
  if (offer?.scope === 'runtime') {
    return { kind: 'auto-save-runtime-offer', offer }
  }
  if (offer) {
    return { kind: 'show-connect', initialPairingInput: args.initialPairingInput }
  }
  return args.hasStoredEnvironment
    ? { kind: 'use-stored-environment' }
    : { kind: 'show-connect', initialPairingInput: null }
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
  const scope = parseWebPairingScope(parsed.scope)
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: normalizeWebSocketEndpoint(parsed.endpoint),
    deviceToken: parsed.deviceToken,
    publicKeyB64: parsed.publicKeyB64,
    ...(scope ? { scope } : {})
  }
}

function parseWebPairingScope(value: unknown): DeviceScope | null {
  return value === 'mobile' || value === 'runtime' ? value : null
}

function extractPairingCodeFromUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  // Why: prefix checks accepted routes like `orca://pairing?...`; only the
  // pairing deep-link host may carry runtime auth material.
  if (parsed.protocol !== 'orca:' || parsed.hostname !== 'pair') {
    return null
  }
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    return null
  }
  const code = parsed.searchParams.get('code')
  if (code) {
    return code
  }
  return parsed.hash ? parsed.hash.slice(1) || null : null
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = globalThis.atob(padded)
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
