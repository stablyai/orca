export type IrohRelayPresetId = 'automatic' | 'europe' | 'us-east' | 'us-west' | 'asia'

export type IrohRelayPreset = {
  id: IrohRelayPresetId
  relayUrl: string | null
}

export const IROH_RELAY_PRESETS: readonly IrohRelayPreset[] = [
  { id: 'automatic', relayUrl: null },
  { id: 'europe', relayUrl: 'https://euc1-1.relay.n0.iroh.link./' },
  { id: 'us-east', relayUrl: 'https://use1-1.relay.n0.iroh.link./' },
  { id: 'us-west', relayUrl: 'https://usw1-1.relay.n0.iroh.link./' },
  { id: 'asia', relayUrl: 'https://aps1-1.relay.n0.iroh.link./' }
]

const INVALID_RELAY =
  'Choose Automatic or a single HTTPS relay origin without credentials, paths, queries, or fragments.'

/** null selects the SDK defaults; explicit origins are canonical and never include secrets. */
export function parseIrohRelayUrl(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value !== 'string') {
    throw new Error(INVALID_RELAY)
  }
  const relayUrl = value.trim()
  if (!relayUrl) {
    return null
  }
  if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(relayUrl) || /:\/?$/.test(relayUrl)) {
    throw new Error(INVALID_RELAY)
  }
  let url: URL
  try {
    url = new URL(relayUrl)
  } catch {
    throw new Error(INVALID_RELAY)
  }
  if (url.protocol !== 'https:' || !url.hostname || url.port === '0') {
    throw new Error(INVALID_RELAY)
  }
  return `${url.origin}/`
}

/** Match a canonical relay preference to a preset, or custom when no origin matches. */
export function getIrohRelayPreset(relayUrl: string | null): IrohRelayPresetId | 'custom' {
  return IROH_RELAY_PRESETS.find((preset) => preset.relayUrl === relayUrl)?.id ?? 'custom'
}
