import type {
  PortForwardEntry,
  EnrichedDetectedPort
} from '../../../../shared/remote-runtime/ssh/ssh-types'
import type { WorkspacePort } from '../../../../shared/workspace/ports/workspace-ports'
import { portForwardKey } from '@/components/right-sidebar/ports/port-forward-remote-host'

const HTTPS_PORTS = new Set([443, 8443])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

// Normalize numeric bind addresses to URLs browsers can reliably open.
function hostForLocalAction(host: string): string {
  if (!host) {
    return 'localhost'
  }
  return host.includes(':') ? `[${host}]` : host
}

export function addressForPort(port: WorkspacePort): string {
  // Prefer terminal-advertised origins over kernel binds; users expect custom hostnames in copied URLs.
  if (port.kind === 'workspace' && port.advertisedUrl) {
    try {
      const url = new URL(port.advertisedUrl)
      return url.host || `${hostForLocalAction(port.connectHost)}:${port.port}`
    } catch {
      // Fall through to OS-derived address.
    }
  }
  return `${hostForLocalAction(port.connectHost)}:${port.port}`
}

export function browserUrlForPort(port: WorkspacePort): string {
  if (port.kind === 'workspace' && port.advertisedUrl) {
    return port.advertisedUrl
  }
  const protocol = port.protocol === 'https' ? 'https' : 'http'
  return `${protocol}://${hostForLocalAction(port.connectHost)}:${port.port}`
}

/** Reuse advertised DNS names with local SSH-forward ports; reject remote loopback/IP literals and fall back to 127.0.0.1. Trust user host mappings without DNS probing. */
function customHostFromAdvertised(advertisedUrl: string | undefined): string | null {
  if (!advertisedUrl) {
    return null
  }
  try {
    const url = new URL(advertisedUrl)
    const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (LOOPBACK_HOSTS.has(hostname)) {
      return null
    }
    // IPv4 or IPv6 literals are not portable to the local box.
    if (/^[0-9.]+$/.test(hostname) || hostname.includes(':')) {
      return null
    }
    return url.hostname
  } catch {
    return null
  }
}

type AdvertisedPortUrlFields = {
  advertisedProtocol?: 'http' | 'https'
  advertisedUrl?: string
  remotePort: number
}

function advertisedProtocolForPort(port: AdvertisedPortUrlFields): 'http' | 'https' {
  if (port.advertisedProtocol) {
    return port.advertisedProtocol
  }
  if (port.advertisedUrl) {
    try {
      const protocol = new URL(port.advertisedUrl).protocol.replace(/:$/, '')
      if (protocol === 'http' || protocol === 'https') {
        return protocol
      }
    } catch {
      // Fall through to the same port heuristic used for entries without an advertised URL.
    }
  }
  return HTTPS_PORTS.has(port.remotePort) ? 'https' : 'http'
}

export function browserUrlForPortForwardEntry(entry: PortForwardEntry): string {
  // Older enriched rows can lack advertisedProtocol; derive once to keep labels/open actions consistent.
  const protocol = advertisedProtocolForPort(entry)
  const host = customHostFromAdvertised(entry.advertisedUrl) ?? '127.0.0.1'
  return `${protocol}://${host}:${entry.localPort}`
}

/** The address of an SSH host's URL through the forward of its host and port; null when that port is not forwarded. */
export function forwardedUrlForRemoteUrl(
  rawUrl: string,
  forwards: readonly PortForwardEntry[]
): string | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // Browsers resolve *.localhost to loopback themselves.
  const isLocalhostName = hostname === 'localhost' || hostname.endsWith('.localhost')
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const key = portForwardKey(isLocalhostName ? 'localhost' : hostname, port)
  const forward = forwards.find(
    (entry) => portForwardKey(entry.remoteHost, entry.remotePort) === key
  )
  if (!forward) {
    return null
  }
  // Keep the page's own loopback name for its Host header; the listener is IPv4 only, so other hosts map to it.
  if (!isLocalhostName && hostname !== '127.0.0.1') {
    url.hostname = '127.0.0.1'
  }
  url.port = String(forward.localPort)
  return url.toString()
}

export function addressForPortForwardEntry(entry: PortForwardEntry): string {
  return new URL(browserUrlForPortForwardEntry(entry)).host
}

export function advertisedBrowserUrlForForwardedRow(entry: PortForwardEntry): string | null {
  if (!customHostFromAdvertised(entry.advertisedUrl)) {
    return null
  }
  return browserUrlForPortForwardEntry(entry)
}

export function advertisedBrowserUrlForDetectedPort(port: EnrichedDetectedPort): string | null {
  const host = customHostFromAdvertised(port.advertisedUrl)
  if (!host) {
    return null
  }
  const protocol = advertisedProtocolForPort({
    advertisedProtocol: port.advertisedProtocol,
    advertisedUrl: port.advertisedUrl,
    remotePort: port.port
  })
  return `${protocol}://${host}:${port.port}`
}
