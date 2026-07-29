/**
 * Appends an actionable Tailscale recommendation to remote-runtime connection
 * failures, mirroring `withMacTailscaleDnsHint`. Lives in `shared` as a pure,
 * dependency-free function so both the main process (desktop transport) and the
 * renderer (web client) can route their user-facing errors through it without
 * leaking presentation copy into the shared error constructors (which the CLI,
 * logs, and mobile typecheck also consume).
 */

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
    // Why: a bare host (no scheme) isn't a valid URL; strip any scheme and take
    // the authority up to the first port/path/query delimiter.
    host = endpoint.replace(/^[a-z]+:\/\//i, '').split(/[/:?#]/, 1)[0] || null
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

export function withRemoteRuntimeTailscaleHint(
  message: string,
  endpoint: string | null | undefined
): string {
  if (!REMOTE_RUNTIME_UNREACHABLE_RE.test(message)) {
    return message
  }
  // Why: keep the hint idempotent so a message routed through this helper twice
  // (e.g. re-wrapped error response) isn't suffixed with duplicate guidance.
  if (/tailscale/i.test(message)) {
    return message
  }
  if (isTailscaleEndpoint(endpoint)) {
    // Why: a server already reached over Tailscale fails for tailnet-specific
    // reasons, so "use Tailscale" would be useless — point at the real causes.
    // Already-paired devices keep their saved token across server restarts, so
    // re-pairing only matters when adding a new device.
    return `${message} The server may be offline on your tailnet, or its Tailscale Funnel reverted to tailnet-only. Confirm it's reachable; re-pair only when adding a new device, since already-paired devices reconnect with their saved token.`
  }
  return `${message} If the server is on another network, connect both devices to Tailscale and pair using its Tailscale address (100.x or a *.ts.net name). See ${TAILSCALE_DOWNLOAD_URL}.`
}
