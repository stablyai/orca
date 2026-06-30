import { normalizeGitErrorMessage, stripCredentialsFromMessage } from './git-remote-error'

/**
 * Discriminated code for a refresh-base-ref failure, used by both the main
 * throw sites and the renderer to pick an i18n key.
 *
 * `'unknown'` is a catch-all for stderr that matches none of the specific
 * patterns below.
 */
export type RefreshBaseRefErrorCode =
  | 'network'
  | 'auth'
  | 'noUpstream'
  | 'remoteRefMissing'
  | 'remoteForbidden'
  | 'unknown'

/** Lookup set used to validate a parsed `[code]` prefix against the known codes. */
const REFRESH_BASE_REF_CODE_SET = new Set<RefreshBaseRefErrorCode>([
  'network',
  'auth',
  'noUpstream',
  'remoteRefMissing',
  'remoteForbidden',
  'unknown'
])

/** Result of `classifyRefreshBaseRefError`: the matched code plus a human-readable message. */
export type ClassifiedRefreshBaseRefError = {
  code: RefreshBaseRefErrorCode
  message: string
}

// Why: short single-line descriptions are clearer as comment-style captions
// for these regex constants than as JSDoc blocks above each one — the JSDoc
// tool counts them via the function/export scan above.

// git fetch on DNS failure or network unreachable
const REFRESH_NETWORK_PATTERN =
  /Could not resolve host|Network is unreachable|Connection (reset|timed out|refused)/i
// SSH publickey auth or HTTPS auth failure
const REFRESH_AUTH_PATTERN =
  /Authentication failed|Permission denied \(publickey\)|could not read Username/i
// git fetch when no upstream tracking info is configured
const REFRESH_NO_UPSTREAM_PATTERN = /no tracking information|no upstream/i
// git fetch when the requested ref does not exist on the remote
const REMOTE_REF_MISSING_PATTERN = /couldn't find remote ref|remote ref does not exist/i
// git fetch when the remote returns 401/403/404 or 'Repository not found'
const REMOTE_FORBIDDEN_PATTERN =
  /repository .* not found|requested url returned error: (401|403|404)/i

/**
 * Map raw `git fetch` stderr to a `RefreshBaseRefErrorCode`.
 *
 * Why: scan only the first 'fatal:' line (falling back to the full stderr
 * if no fatal: line exists) so a benign help-text mention of "no upstream"
 * in later lines doesn't override the actual failure cause.
 *
 * Why: SSH auth rejections like "Permission denied (publickey)." land
 * BEFORE the appended "fatal: Could not read from remote repository."
 * tail line. Match the auth pattern against the full stderr so that
 * trailing fatal noise can't hide the real cause from the classify step.
 */
function detectRefreshBaseRefErrorCode(rawStderr: string): RefreshBaseRefErrorCode {
  const scoped = (() => {
    const fatalLine = rawStderr.split(/\r?\n/).find((line) => /^fatal:\s/.test(line))
    return fatalLine ?? rawStderr
  })()
  if (REFRESH_NETWORK_PATTERN.test(scoped)) {
    return 'network'
  }
  if (REFRESH_AUTH_PATTERN.test(rawStderr)) {
    return 'auth'
  }
  if (REFRESH_NO_UPSTREAM_PATTERN.test(scoped)) {
    return 'noUpstream'
  }
  if (REMOTE_REF_MISSING_PATTERN.test(scoped)) {
    return 'remoteRefMissing'
  }
  if (REMOTE_FORBIDDEN_PATTERN.test(scoped)) {
    return 'remoteForbidden'
  }
  return 'unknown'
}

/**
 * Best-effort classifier for a refresh-base-ref failure.
 *
 * Why: the precheck and runtime throw sites synthesize a fallback Error
 * like "refresh failed: git_error" from `RemoteFetchResult.errorKind`
 * (which carries no stderr). That synthesized message matches none of
 * the 5 patterns above, so both surfaces always emit `unknown` — the
 * 5 specific i18n keys are exercised only by the createRemoteWorktree
 * path (Task 2 site) which has the real git stderr. This is a known
 * limitation until the runtime's RemoteFetchResult carries stderr.
 *
 * Non-Error rejections fall through to `{code: 'unknown', message: 'Git remote operation failed.'}`.
 */
export function classifyRefreshBaseRefError(error: unknown): ClassifiedRefreshBaseRefError {
  if (!(error instanceof Error)) {
    return { code: 'unknown', message: 'Git remote operation failed.' }
  }
  const stderr = stripCredentialsFromMessage(error.message)
  const code = detectRefreshBaseRefErrorCode(stderr)
  const humanMessage = normalizeGitErrorMessage(error, 'fetch')
  return { code, message: humanMessage }
}

/**
 * Render a classified error as `[code] message` — the wire format the
 * renderer's `parseRefreshBaseRefErrorPrefix` can split back apart.
 */
export function formatRefreshBaseRefError(result: ClassifiedRefreshBaseRefError): string {
  return `[${result.code}] ${result.message}`
}

/**
 * Inverse of `formatRefreshBaseRefError`: pull the `[code]` prefix out
 * of a thrown-message string. Returns `null` when the string either has
 * no prefix or carries an unrecognized code, so callers can fall back to
 * rendering the raw message verbatim.
 */
export function parseRefreshBaseRefErrorPrefix(
  message: string
): { code: RefreshBaseRefErrorCode; message: string } | null {
  const match = message.match(/^\[(\w+)\]\s*(.*)$/)
  if (!match) {
    return null
  }
  const code = match[1] as RefreshBaseRefErrorCode
  if (!REFRESH_BASE_REF_CODE_SET.has(code)) {
    return null
  }
  return { code, message: match[2] }
}

/**
 * Shared throw helper for the three refresh-base-ref sites (refresh,
 * precheck, runtime). Logs a credential-scrubbed copy of the cause to
 * `console.error` (tagged with the call site) and throws an Error whose
 * message is the formatted `[code]` form ready for the renderer to
 * parse and map to i18n.
 *
 * Why: scrub before logging so credentials embedded in the original
 * stderr never reach console (which can be piped to log files / bug
 * reports). Both Error and non-Error rejections get scrubbed — a thrown
 * string/object can still carry credentials in serialized form.
 */
export function throwRefreshBaseRefError(opts: {
  tag: 'refresh-base-ref' | 'refresh-base-ref-precheck' | 'refresh-base-ref-runtime'
  baseBranch: string
  remote: string
  cause: unknown
}): never {
  const safeCause = (() => {
    if (opts.cause instanceof Error) {
      return new Error(stripCredentialsFromMessage(opts.cause.message))
    }
    if (typeof opts.cause === 'string') {
      return stripCredentialsFromMessage(opts.cause)
    }
    if (opts.cause === null || opts.cause === undefined) {
      return opts.cause
    }
    // Why: unknown shape — stringify then scrub so any embedded credentials in
    // a serialized object literal don't leak to log sinks.
    return stripCredentialsFromMessage(String(opts.cause))
  })()
  console.error(`[${opts.tag}]`, safeCause)
  const classified = classifyRefreshBaseRefError(opts.cause)
  throw new Error(
    formatRefreshBaseRefError({
      code: classified.code,
      message: `Could not refresh base ref "${opts.baseBranch}" from "${opts.remote}".`
    })
  )
}
