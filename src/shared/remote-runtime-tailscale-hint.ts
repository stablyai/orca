/**
 * Appends the dialed endpoint and an actionable network recommendation to
 * remote-runtime connection failures, mirroring `withMacTailscaleDnsHint`. Lives
 * in `shared` as a pure function with no package dependencies so both the main
 * process (desktop transport) and the renderer (web client) can route their
 * user-facing errors through it without leaking presentation copy into the
 * shared error constructors (which the CLI, logs, and mobile typecheck also
 * consume).
 */
import { classifyRemotePairingHostname, displayableEndpoint } from './remote-pairing-endpoint'

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download'

// Why: only the "runtime is unreachable" family of failures has a Tailscale
// remedy; auth/protocol errors pass through untouched.
const REMOTE_RUNTIME_UNREACHABLE_RE =
  /could not connect to the remote orca runtime|remote orca runtime closed the connection|timed out (?:waiting for|while connecting to) the remote orca runtime/i

const TAILSCALE_MAGIC_DNS_SUFFIX_RE = /(?:^|\.)ts\.net$/i
// Why: gate the CGNAT check on a full IPv4 literal — the range regex alone also
// matches DNS names like `100.64.0.1.example.com`, which aren't Tailscale IPs.
const IPV4_LITERAL_RE =
  /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
// Tailscale assigns node IPs from the 100.64.0.0/10 CGNAT range (second octet 64–127).
const TAILSCALE_CGNAT_RE = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./
// Tailscale also assigns each node an IPv6 address from the fd7a:115c:a1e0::/48 ULA
// block, and pairing endpoints can carry an IPv6 literal (see resolvePairingEndpoint).
const TAILSCALE_IPV6_RE = /^fd7a:115c:a1e0:/i

function extractHost(endpoint: string): string | null {
  let host: string | null
  try {
    host = new URL(endpoint).hostname || null
  } catch {
    // Why: a bare host (no scheme) isn't a valid URL; strip any scheme, take the authority,
    // and keep a bracketed IPv6 literal whole — splitting it on `:` like a host:port pair
    // leaves a lone hextet (`[fd7a:…]` -> `fd7a`) that reads as a short hostname downstream.
    const authority = endpoint.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/, 1)[0] ?? ''
    host = /^\[[^\]]*\]/.exec(authority)?.[0] || authority.split(':', 1)[0] || null
  }
  if (!host) {
    return null
  }
  // Why: WHATWG URL keeps IPv6 literals bracketed (`[fd7a:…]`) and FQDNs can carry
  // a trailing dot; normalize both so the host checks below see a bare address/name.
  return host.replace(/^\[|\]$/g, '').replace(/\.$/, '') || null
}

export function isTailscaleEndpoint(endpoint: string | null | undefined): boolean {
  if (!endpoint) {
    return false
  }
  const host = extractHost(endpoint)
  if (!host) {
    return false
  }
  return (
    TAILSCALE_MAGIC_DNS_SUFFIX_RE.test(host) ||
    (IPV4_LITERAL_RE.test(host) && TAILSCALE_CGNAT_RE.test(host)) ||
    TAILSCALE_IPV6_RE.test(host)
  )
}

/**
 * Why: a server already reached over Tailscale fails for tailnet-specific reasons, so "use
 * Tailscale" would be useless — point at the real causes. Already-paired devices keep their
 * saved token across server restarts, so re-pairing only matters when adding a new device.
 */
const TAILNET_ENDPOINT_HINT =
  "The server may be offline on your tailnet, or its Tailscale Funnel reverted to tailnet-only. Confirm it's reachable; re-pair only when adding a new device, since already-paired devices reconnect with their saved token."

// Why: a LAN address is unreachable from another network no matter how much Tailscale is
// installed — but it is also the ordinary address for a device on the same network, so state
// the condition rather than asserting a cause the client cannot verify, and keep the install
// pointer the other hint carries for a user who is not on a tailnet at all.
const LAN_ENDPOINT_HINT_BODY = `is a local-network address. If this device is not on the server's network it cannot reach it — re-pair with an address it can reach, such as the server's Tailscale address (100.x or a *.ts.net name); see ${TAILSCALE_DOWNLOAD_URL}. Otherwise check that the server is awake and not firewalling the port.`

const OTHER_NETWORK_HINT = `If the server is on another network, connect both devices to Tailscale and pair using its Tailscale address (100.x or a *.ts.net name). See ${TAILSCALE_DOWNLOAD_URL}.`

// Why: the hint opens with a subject, so it must know whether the message it is appended to
// actually named an address — otherwise "That" points at the previous clause instead.
function lanEndpointHint(endpointNamed: boolean): string {
  return `${endpointNamed ? 'That' : 'The paired address'} ${LAN_ENDPOINT_HINT_BODY}`
}

export function withRemoteRuntimeTailscaleHint(
  message: string,
  endpoint: string | null | undefined
): string {
  if (!REMOTE_RUNTIME_UNREACHABLE_RE.test(message)) {
    return message
  }
  // Why: keep the hint idempotent so a message routed through this helper twice (e.g. a
  // re-wrapped error response) isn't suffixed with duplicate guidance. Keyed on the hints
  // themselves, not on the word — messages now carry an endpoint whose host can contain it.
  if (
    message.endsWith(TAILNET_ENDPOINT_HINT) ||
    message.endsWith(LAN_ENDPOINT_HINT_BODY) ||
    message.endsWith(OTHER_NETWORK_HINT)
  ) {
    return message
  }
  const display = endpoint ? displayableEndpoint(endpoint) : null
  return `${withDialedEndpoint(message, display)} ${hintForEndpoint(endpoint, display !== null)}`
}

// Why: name the address that was actually dialed, so a stale or unreachable address in the
// pairing link is visible instead of the hint implying the network itself is at fault. One
// phrasing only — `at <endpoint>`, the same shape `remoteRuntimeConnectFailureMessage` already
// uses on the handshake-timeout path — so the family reads as one message, not two.
function withDialedEndpoint(message: string, display: string | null): string {
  if (!display || namesEndpoint(message, display)) {
    return message
  }
  return message.endsWith('.')
    ? `${message.slice(0, -1)} at ${display}.`
    : `${message} at ${display}`
}

/**
 * Why not `message.includes(display)`: `ws://a.example` is a substring of a message naming
 * `ws://a.example.com`, which would silently drop the address for a different host. An
 * occurrence only counts when what follows cannot extend the host or its port.
 */
function namesEndpoint(message: string, display: string): boolean {
  for (
    let index = message.indexOf(display);
    index !== -1;
    index = message.indexOf(display, index + 1)
  ) {
    if (!/^(?:[a-z0-9.-]|:\d)/i.test(message.slice(index + display.length))) {
      return true
    }
  }
  return false
}

function hintForEndpoint(endpoint: string | null | undefined, endpointNamed: boolean): string {
  if (isTailscaleEndpoint(endpoint)) {
    return TAILNET_ENDPOINT_HINT
  }
  const host = endpoint ? extractHost(endpoint) : null
  const kind = host ? classifyRemotePairingHostname(host) : null
  // Why: the classifier also recognises IPv4-mapped IPv6 tailnet literals isTailscaleEndpoint misses.
  if (kind === 'tailscale') {
    return TAILNET_ENDPOINT_HINT
  }
  return kind === 'lan' ? lanEndpointHint(endpointNamed) : OTHER_NETWORK_HINT
}
