import { normalizeGitErrorMessage, stripCredentialsFromMessage } from './git-remote-error'

export type RefreshBaseRefErrorCode =
  | 'network'
  | 'auth'
  | 'noUpstream'
  | 'remoteRefMissing'
  | 'remoteForbidden'
  | 'unknown'

const REFRESH_BASE_REF_CODE_SET = new Set<RefreshBaseRefErrorCode>([
  'network',
  'auth',
  'noUpstream',
  'remoteRefMissing',
  'remoteForbidden',
  'unknown'
])

export type ClassifiedRefreshBaseRefError = {
  code: RefreshBaseRefErrorCode
  message: string
}

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

function detectRefreshBaseRefErrorCode(rawStderr: string): RefreshBaseRefErrorCode {
  if (REFRESH_NETWORK_PATTERN.test(rawStderr)) {
    return 'network'
  }
  if (REFRESH_AUTH_PATTERN.test(rawStderr)) {
    return 'auth'
  }
  if (REFRESH_NO_UPSTREAM_PATTERN.test(rawStderr)) {
    return 'noUpstream'
  }
  if (REMOTE_REF_MISSING_PATTERN.test(rawStderr)) {
    return 'remoteRefMissing'
  }
  if (REMOTE_FORBIDDEN_PATTERN.test(rawStderr)) {
    return 'remoteForbidden'
  }
  return 'unknown'
}

// Why: the precheck and runtime throw sites synthesize a fallback Error
// like "refresh failed: git_error" from `RemoteFetchResult.errorKind`
// (which carries no stderr). That synthesized message matches none of
// the 5 patterns above, so both surfaces always emit `unknown` — the
// 5 specific i18n keys are exercised only by the createRemoteWorktree
// path (Task 2 site) which has the real git stderr. This is a known
// limitation until the runtime's RemoteFetchResult carries stderr.
export function classifyRefreshBaseRefError(error: unknown): ClassifiedRefreshBaseRefError {
  if (!(error instanceof Error)) {
    return { code: 'unknown', message: 'Git remote operation failed.' }
  }
  const stderr = stripCredentialsFromMessage(error.message)
  const code = detectRefreshBaseRefErrorCode(stderr)
  const humanMessage = normalizeGitErrorMessage(error, 'fetch')
  return { code, message: humanMessage }
}

export function formatRefreshBaseRefError(result: ClassifiedRefreshBaseRefError): string {
  return `[${result.code}] ${result.message}`
}

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
