// Why: a GitHub outage, a dropped network, or a rate-limit all surface as
// unstructured gh/Octokit error text. Detecting them from one shared place lets
// both the main process (PR-refresh classification) and the renderer (Tasks
// work-item fan-out) attribute the failure to GitHub — not to Orca — using the
// exact same rules, so the two surfaces never disagree about whether GitHub is
// reachable. Returns null for anything that is NOT a reachability problem
// (auth, permission, 404): those are user-actionable, not "GitHub is down".

export type GitHubUnavailableKind = 'server_error' | 'network' | 'rate_limited'

// Rate-limit first: a primary rate-limit response also carries "HTTP 403", so
// it must win over any 4xx/permission interpretation downstream.
const RATE_LIMITED_PATTERN =
  /rate limit|secondary rate limit|abuse detection|\bhttp[\s/]*429\b|\b429 too many requests\b/i

// Server-side outage. Anchor on "HTTP 5xx" or named 5xx statuses rather than a
// bare 3-digit match so unrelated numbers in stderr can't be misread as an
// outage.
const SERVER_ERROR_PATTERN =
  /\bhttp[\s/]*5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out)\b|\binternal server error\b|\bbad gateway\b|\bservice unavailable\b|\bgateway time-?out\b|\bserver error\b|\btemporarily unavailable\b/i

// Transport-level failures — DNS, refused/reset connections, timeouts. Covers
// both Node (ENOTFOUND/ECONNRESET) and the gh Go client ("dial tcp", "i/o
// timeout", "no such host") shapes.
const NETWORK_PATTERN =
  /timeout|\btimed out\b|\bno such host\b|could not resolve host|could not resolve to a host|\bnetwork(?:error| (?:error|unavailable|unreachable|request failed))\b|\bconnection (?:refused|reset)\b|\berror connecting to\b|\bfailed to connect to\b|\bdial tcp\b|\bi\/o timeout\b|\bfetch failed\b|\bsocket hang up\b|ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i

/**
 * Classify a gh/Octokit error message as a GitHub-reachability problem, or
 * null when it is not one (auth, permission, 404, validation, etc.).
 */
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
