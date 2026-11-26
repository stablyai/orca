import type { BrowserNetworkTunnelOpen } from '../browser/network/tunnels/browser-network-tunnel-protocol'
import { getProxyUrlFromEnvironment, normalizeProxyUrl } from '../network/network-proxy'
import { readNetworkProxySettings } from '../../main/browser/network/execution-routes/browser-network-proxy-settings-source'
import {
  selectBrowserNetworkTunnelProxy,
  type BrowserNetworkTunnelProxy
} from '../../main/browser/network/tunnels/browser-network-tunnel-proxy-selection'
import { defaultProxySession } from '../../main/network/electron-default-proxy-session'
import { classifyRemotePairingHostname } from './pairing/remote-pairing-address'

export type RemoteRuntimeProxySelection = {
  proxy: BrowserNetworkTunnelProxy
  /** Scheme, host and port of the proxy without credentials; null when dialling directly. */
  label: string | null
}

const DIRECT: RemoteRuntimeProxySelection = { proxy: { kind: 'direct' }, label: null }

/** Loopback, private-network and Tailscale endpoints keep their direct dial. */
export function remoteRuntimeEndpointNeedsProxySelection(endpoint: URL): boolean {
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') {
    return false
  }
  const kind = classifyRemotePairingHostname(endpoint.hostname)
  return kind === 'public' || kind === 'custom'
}

/** Orca's setting, then the environment, then the session's system proxy (desktop only). */
export async function selectRemoteRuntimeProxy(
  endpoint: URL,
  target: BrowserNetworkTunnelOpen,
  env: Record<string, string | undefined> = process.env
): Promise<RemoteRuntimeProxySelection> {
  const settings = readNetworkProxySettings()
  const configured = normalizeProxyUrl(settings?.httpProxyUrl)
  const proxyUrl = (configured.ok && configured.value) || getProxyUrlFromEnvironment(env).value
  if (proxyUrl) {
    const proxy = selectBrowserNetworkTunnelProxy(target, settings, env)
    return { proxy, label: proxy.kind === 'direct' ? null : proxyLabel(new URL(proxyUrl)) }
  }
  const session = defaultProxySession()
  if (!session) {
    return DIRECT
  }
  return parseResolvedProxy(await session.resolveProxy(systemProxyProbeUrl(endpoint)))
}

// Chromium resolves WebSocket URLs as their HTTP equivalents, so PAC scripts see https://.
function systemProxyProbeUrl(endpoint: URL): string {
  const probe = new URL(endpoint.href)
  probe.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  probe.username = ''
  probe.password = ''
  return probe.href
}

const PAC_SCHEMES: Record<string, string> = {
  PROXY: 'http:',
  HTTP: 'http:',
  HTTPS: 'https:',
  SOCKS5: 'socks5:',
  // Chromium reads a bare SOCKS entry as SOCKS v4.
  SOCKS: 'socks4:',
  SOCKS4: 'socks4:'
}

/** Takes the first entry of a Chromium proxy list such as `PROXY 127.0.0.1:7890; DIRECT`. */
export function parseResolvedProxy(resolved: string): RemoteRuntimeProxySelection {
  const [keyword = '', hostPort = ''] = (resolved.split(';')[0] ?? '').trim().split(/\s+/)
  const upper = keyword.toUpperCase()
  if (upper === '' || upper === 'DIRECT') {
    return DIRECT
  }
  const protocol = PAC_SCHEMES[upper] ?? `${upper.toLowerCase().replace(/[^a-z0-9+.-]/g, '')}:`
  let url: URL
  try {
    url = new URL(`${protocol}//${hostPort}`)
  } catch {
    return { proxy: { kind: 'unsupported', protocol }, label: protocol }
  }
  const proxy: BrowserNetworkTunnelProxy =
    protocol === 'http:' || protocol === 'https:'
      ? { kind: 'http', url }
      : protocol === 'socks5:'
        ? { kind: 'socks5', url }
        : { kind: 'unsupported', protocol }
  return { proxy, label: proxyLabel(url) }
}

function proxyLabel(url: URL): string {
  return `${url.protocol}//${url.host}`
}

/** `socks4:` reads as SOCKS4 in failure messages. */
export function remoteRuntimeProxyKindName(protocol: string): string {
  return protocol.replace(/:$/, '').toUpperCase()
}
