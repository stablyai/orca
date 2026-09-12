// Shared types for user-configured "custom git servers" — self-hosted / internal
// hosts (e.g. https://git.example.com) that Orca talks to over a native REST API.
// The API "flavor" is pluggable so new server APIs can be added without touching
// the provider/persistence/UI plumbing; GitLab-compatible is the first flavor.

/** Which REST API a custom server speaks. Extensible: add a value here plus a
 *  flavor client in src/main/custom-git-server/api-flavor.ts. */
export type CustomGitServerApiFlavor = 'gitlab'

/** All supported API flavors (the runtime counterpart of CustomGitServerApiFlavor). */
export const CUSTOM_GIT_SERVER_API_FLAVORS: readonly CustomGitServerApiFlavor[] = ['gitlab']

/** Flavor used when none is specified or a stored value is invalid. */
export const DEFAULT_CUSTOM_GIT_SERVER_API_FLAVOR: CustomGitServerApiFlavor = 'gitlab'

/** Persisted server definition (the token is stored separately, encrypted). */
export type CustomGitServer = {
  id: string
  /** User-facing label, e.g. "My Git Server". */
  name: string
  /** Normalized remote host, e.g. "git.example.com" (may include :port). */
  host: string
  /** Web/API origin, e.g. "https://git.example.com". Flavor clients append their
   *  own API path (e.g. /api/v4) to this. */
  apiBaseUrl: string
  apiFlavor: CustomGitServerApiFlavor
}

/** A server definition submitted from the UI before it has an id. */
export type CustomGitServerDraft = {
  name: string
  host: string
  apiBaseUrl: string
  apiFlavor: CustomGitServerApiFlavor
  /** Optional on update (keep existing token when omitted). */
  token?: string
}

/** Renderer-facing status for one configured server. */
export type CustomGitServerStatus = {
  id: string
  name: string
  host: string
  apiBaseUrl: string
  apiFlavor: CustomGitServerApiFlavor
  /** A token is saved for this server. */
  configured: boolean
  /** The saved token authenticated against the server. */
  authenticated: boolean
  account: string | null
}

export type CustomGitServerTestResult =
  | { ok: true; account: string | null }
  | { ok: false; error: string }

/** Type guard for a known API flavor. */
export function isCustomGitServerApiFlavor(value: unknown): value is CustomGitServerApiFlavor {
  return typeof value === 'string' && (CUSTOM_GIT_SERVER_API_FLAVORS as readonly string[]).includes(value)
}

/**
 * Normalize a host or URL to a comparable host token: lowercase hostname with an
 * optional `:port`, protocol/path/credentials stripped. Accepts bare hosts
 * ("git.example.com"), URLs ("https://git.example.com/x"), and scp-like remotes
 * ("git@git.example.com:owner/repo.git").
 */
export function normalizeCustomGitServerHost(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }
  // URL form (has a scheme).
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed)
      const protocol = url.protocol.toLowerCase()
      // For http(s) the URL port identifies the endpoint; for ssh it's transport.
      const host = protocol === 'http:' || protocol === 'https:' ? url.host : url.hostname
      return host.toLowerCase()
    } catch {
      return ''
    }
  }
  // scp-like form: [user@]host:path — but a bare `host:port` (no user, numeric
  // or non-path suffix) is NOT scp, so only strip to host when there's a user@
  // prefix or a `/` path after the colon; otherwise keep it as host[:port].
  const scpLike = trimmed.match(/^([^@/:]+@)?([^:\s/]+):([^\s]+)$/)
  if (scpLike) {
    const [, user, host, rest] = scpLike
    if (user || rest.includes('/')) {
      return host.toLowerCase()
    }
  }
  // Bare host, possibly `host:port`, possibly with a trailing path the user pasted.
  return trimmed.replace(/\/.*$/, '').replace(/\/+$/, '').toLowerCase()
}

/** Strip a trailing `:port` so hostname-only comparisons can fall back. */
function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, '')
}

/** Trim/normalize the stored API base URL: ensure a scheme, drop trailing slashes. */
export function normalizeCustomGitServerApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/**
 * Find the configured server whose host matches `remoteHost`. Matches an exact
 * normalized host, and falls back to a hostname-only match so a server saved
 * without a port still claims a remote on the same hostname.
 */
export function matchCustomGitServerForHost<T extends { host: string }>(
  remoteHost: string,
  servers: readonly T[]
): T | null {
  const normalized = normalizeCustomGitServerHost(remoteHost)
  if (!normalized) {
    return null
  }
  const normalizedHostname = hostnameOf(normalized)
  for (const server of servers) {
    const serverHost = normalizeCustomGitServerHost(server.host)
    if (serverHost === normalized) {
      return server
    }
    // Only relax to hostname when the saved host carries no explicit port.
    if (hostnameOf(serverHost) === serverHost && serverHost === normalizedHostname) {
      return server
    }
  }
  return null
}
