import { classifyRemotePairingHostname } from '../remote-pairing-address'
import { normalizePairingUrl } from './pairing-url'

export const CLOUDFLARE_QUICK_TUNNEL_SUFFIX = '.trycloudflare.com'

export type ParseCloudflareTunnelAddressResult = { ok: true; value: string } | { ok: false }

// Why: `cloudflared` prints an https:// URL, and `resolveAdvertisedPairingEndpoint` only skips
// grafting the bound local port onto the advertised host when the address carries a scheme — a bare
// `foo.trycloudflare.com` would advertise `ws://foo.trycloudflare.com:6768`, which the tunnel edge
// (443) never answers. So always normalize to a full ws(s):// URL.
export function parseCloudflareTunnelAddress(input: string): ParseCloudflareTunnelAddressResult {
  const trimmed = input.trim()
  if (trimmed === '' || /\s/.test(trimmed)) {
    return { ok: false }
  }
  const normalized = normalizePairingUrl(trimmed.includes('://') ? trimmed : `wss://${trimmed}`)
  if (!normalized) {
    return { ok: false }
  }
  // normalizePairingUrl maps http: to ws:, which would carry pairing traffic to a public host in
  // cleartext. cloudflared always terminates TLS, so anything but wss: here is a mistake.
  if (!normalized.startsWith('wss://')) {
    return { ok: false }
  }
  // A tunnel fronting loopback, a tailnet, or a LAN host mints a link the outside world cannot
  // open; those destinations belong to the other intents.
  return classifyRemotePairingHostname(new URL(normalized).hostname) === 'public'
    ? { ok: true, value: normalized }
    : { ok: false }
}

// Why: quick tunnels mint a fresh hostname on every `cloudflared` restart, so a link generated
// against one dies silently when the tunnel is restarted. Named tunnels keep their hostname.
export function isCloudflareQuickTunnelAddress(input: string): boolean {
  const parsed = parseCloudflareTunnelAddress(input)
  return (
    parsed.ok &&
    new URL(parsed.value).hostname.toLowerCase().endsWith(CLOUDFLARE_QUICK_TUNNEL_SUFFIX)
  )
}

// Why 127.0.0.1 regardless of what the listener bound to: cloudflared runs beside the runtime and
// dials it locally, so loopback is correct even after a widen reports `ws://0.0.0.0:<port>`.
export function formatCloudflaredQuickTunnelCommand(port: number): string {
  return `cloudflared tunnel --url http://127.0.0.1:${port}`
}
