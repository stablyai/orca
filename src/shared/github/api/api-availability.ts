// Share gh/Octokit reachability classification between main PR refresh and renderer task fan-out.
// Auth/permission/404 are user-actionable, not outages; return null for those.

export type GitHubUnavailableKind = 'server_error' | 'network' | 'rate_limited'

// Rate-limit 403 must outrank ordinary permission interpretation.
const RATE_LIMITED_PATTERN =
  /rate limit|secondary rate limit|abuse detection|\bhttp[\s/]*429\b|\b429 too many requests\b/i

// Require HTTP/named 5xx diagnostics; arbitrary three-digit numbers do not prove outages.
const SERVER_ERROR_PATTERN =
  /\bhttp[\s/]*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\bserver error\b|\btemporarily unavailable\b/i

// Cover DNS/refusal/reset/timeouts in Node errno and gh Go-client forms.
const NETWORK_PATTERN =
  /timeout|\btimed out\b|\bno such host\b|could not resolve host|could not resolve to a host|\bnetwork(?:error| (?:error|unavailable|unreachable|request failed))\b|\bconnection (?:refused|reset)\b|\berror connecting to\b|\bfailed to connect to\b|\bdial tcp\b|\bi\/o timeout\b|\bfetch failed\b|\bsocket hang up\b|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i

/** Classify reachability failures; return null for auth, permission, 404, validation and other errors. */
export function classifyGitHubUnavailable(message: string): GitHubUnavailableKind | null {
  if (!message) {
    return null
  }
  if (RATE_LIMITED_PATTERN.test(message)) {
    return 'rate_limited'
  }
  if (SERVER_ERROR_PATTERN.test(message)) {
    return 'server_error'
  }
  if (NETWORK_PATTERN.test(message)) {
    return 'network'
  }
  return null
}

/** True when the message indicates GitHub itself is unreachable/unavailable. */
export function isGitHubUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return classifyGitHubUnavailable(message) !== null
}
