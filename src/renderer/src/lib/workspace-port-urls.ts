import { classifyRemotePairingHostname } from '../../../shared/remote-pairing-address'
import type { PortForwardEntry, EnrichedDetectedPort } from '../../../shared/ssh-types'
import { parseLoopbackUrlWithPort } from '../../../shared/localhost-worktree-labels'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import {
  isWildcardBindHost,
  type WorkspacePort,
  type WorkspacePortScanResult
} from '../../../shared/workspace-ports'

const HTTPS_PORTS = new Set([443, 8443])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::'])

// Why: the scanner reports numeric addresses (127.0.0.1, 0.0.0.0, ::1, ::)
// while UI actions should use an address a browser can reliably open.
function hostForLocalAction(host: string): string {
  if (!host) {
    return 'localhost'
  }
  return host.includes(':') ? `[${host}]` : host
}

export function addressForPort(port: WorkspacePort): string {
  // Why: when a dev server printed its own URL to the terminal, that origin
  // (e.g. `local.getmontecarlo.com:3001`) is what the user actually wants in
  // the clipboard, not the kernel bind `127.0.0.1:3001`.
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

export { isWildcardBindHost }

// Why: the address this client already uses to reach the runtime is reachable by
// definition, whatever carries it — LAN, VPN, tailnet, public. Deriving the host from
// the live connection keeps this transport-agnostic instead of probing for a provider.
export function reachableHostnameForEndpoint(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null
  }
  try {
    // Why: URL returns IPv6 hostnames already bracketed, and assigning a *bare* IPv6
    // back to `hostname` silently leaves the original host in place. Passing this
    // value through untouched is what keeps both the substituted and synthesized
    // shapes correct, so do not strip or re-add brackets here.
    const { hostname } = new URL(endpoint)
    if (!hostname) {
      return null
    }
    // An SSH-tunnelled pairing terminates on this client's own loopback, so its address
    // says nothing about how to reach the runtime's dev servers.
    return classifyRemotePairingHostname(hostname) === 'loopback' ? null : hostname
  } catch {
    return null
  }
}

/** URL for a remote workspace's port that the client machine can open in any browser,
 *  or null when no such URL exists — a loopback-bound listener, a relay-only or
 *  SSH-tunnelled connection. Null means "do not offer this", never "try anyway". */
export function clientReachableBrowserUrlForPort(
  port: WorkspacePort,
  runtimeEndpoint: string | null | undefined
): string | null {
  if (!isWildcardBindHost(port.bindHost)) {
    return null
  }
  const hostname = reachableHostnameForEndpoint(runtimeEndpoint)
  if (!hostname) {
    return null
  }
  const advertisedUrl = port.kind === 'workspace' ? port.advertisedUrl : undefined
  if (advertisedUrl) {
    try {
      // Why: the advertised origin carries the scheme the dev server actually speaks;
      // only its host is wrong for this machine. Its port already matches this listener.
      const url = new URL(advertisedUrl)
      url.hostname = hostname
      return url.toString()
    } catch {
      // Fall through to the OS-derived shape.
    }
  }
  const protocol = port.protocol === 'https' ? 'https' : 'http'
  return `${protocol}://${hostname}:${port.port}`
}

/** Extract a custom DNS hostname from an advertised URL for reuse with a
 *  local SSH forward port. Returns null for loopback and IP literals; those
 *  printed-from-remote values don't help the local browser, and callers
 *  should fall back to 127.0.0.1 + local port. A DNS hostname only resolves
 *  locally if the user has /etc/hosts (or equivalent) mapping; we trust that
 *  rather than probing DNS here. */
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
  // Why: older enriched entries may have advertisedUrl without advertisedProtocol;
  // derive the URL once so the open action and labels do not drift.
  const protocol = advertisedProtocolForPort(entry)
  const host = customHostFromAdvertised(entry.advertisedUrl) ?? '127.0.0.1'
  return `${protocol}://${host}:${entry.localPort}`
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

function preferredEndpointForEnvironment(
  environment: PublicKnownRuntimeEnvironment
): string | null {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  return endpoint?.endpoint ?? null
}

/**
 * Reachable URL for a loopback link a remote pane printed, or null.
 *
 * A terminal link carries no WorkspacePort, so the bind is unknown from the text alone
 * and rewriting blind would hand out a URL that cannot connect. The port scan for that
 * environment is the missing half: it says whether the listener behind this port is
 * wildcard-bound. Non-loopback links are left alone — they already name a real host.
 */
export function resolveClientReachableUrlForLoopbackLink(
  state: {
    runtimeEnvironments?: readonly PublicKnownRuntimeEnvironment[]
    workspacePortScansByKey?: Record<string, WorkspacePortScanResult>
  },
  rawUrl: string,
  environmentId: string
): string | null {
  const parsed = parseLoopbackUrlWithPort(rawUrl)
  if (!parsed) {
    return null
  }
  const scan = state.workspacePortScansByKey?.[`environment:${environmentId}:all`]
  const port = scan?.ports.find((candidate) => candidate.port === Number(parsed.port))
  if (!port || !isWildcardBindHost(port.bindHost)) {
    return null
  }
  const environment = (state.runtimeEnvironments ?? []).find((entry) => entry.id === environmentId)
  if (!environment || environment.connectionDependency === 'ssh-tunnel') {
    return null
  }
  const hostname = reachableHostnameForEndpoint(preferredEndpointForEnvironment(environment))
  if (!hostname) {
    return null
  }
  // Why rewrite the parsed URL rather than rebuild it: the printed link may carry a
  // path, query or fragment the user needs, and only the host is wrong for this machine.
  parsed.hostname = hostname
  return parsed.toString()
}
