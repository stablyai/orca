/**
 * Normalize persisted per-project GitHub account bindings.
 *
 * Why: host comparison and gh `--hostname` must be case-insensitive/canonical,
 * while login casing is preserved for display and `gh auth token --user`.
 */

export type GhAccountBinding = {
  host: string
  user: string
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/i
// Why: GHES/LDAP logins often contain `_` or `.`; github.com's hyphen grammar is too strict here.
const USER_RE = /^\S{1,255}$/

export function normalizeGhAccountBinding(value: unknown): GhAccountBinding | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const hostRaw = 'host' in value ? value.host : undefined
  const userRaw = 'user' in value ? value.user : undefined
  if (typeof hostRaw !== 'string' || typeof userRaw !== 'string') {
    return null
  }
  const host = hostRaw.trim().toLowerCase()
  const user = userRaw.trim()
  // Why: reject embedded NUL without a control-char regex (oxlint no-control-regex).
  if (!host || !user || user.includes('\u0000') || !HOST_RE.test(host) || !USER_RE.test(user)) {
    return null
  }
  return { host, user }
}

/** Host-insensitive, login-exact comparison — matches how gh resolves `--hostname` and `--user`. */
export function ghAccountBindingsEqual(
  a: GhAccountBinding | null | undefined,
  b: GhAccountBinding | null | undefined
): boolean {
  if (!a || !b) {
    return a === b
  }
  return a.host === b.host && a.user === b.user
}

/**
 * Choose the env var gh uses for a bound host.
 *
 * Why: github.com / github.localhost / *.ghe.com take `GH_TOKEN`; other hosts
 * need `GH_ENTERPRISE_TOKEN`. Classifying `*.ghe.com` as cloud requires gh ≥
 * 2.46 — older gh may ignore `GH_TOKEN` for those hosts and fail closed as
 * `gh_bound_account_unavailable`.
 */
export function ghTokenEnvVarForHost(host: string): 'GH_TOKEN' | 'GH_ENTERPRISE_TOKEN' {
  const normalized = host.trim().toLowerCase()
  if (
    !normalized ||
    normalized === 'github.com' ||
    normalized === 'github.localhost' ||
    normalized.endsWith('.ghe.com')
  ) {
    return 'GH_TOKEN'
  }
  return 'GH_ENTERPRISE_TOKEN'
}
