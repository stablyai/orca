// Why: git's stderr often embeds the full remote URL, which can include an
// embedded credential — either `https://user:token@host/...` (the classic
// user+pass form) OR `https://token@host/...` (token-only, which GitHub's
// "fine-grained PAT" docs explicitly recommend). Both must be redacted. We
// match an optional `user:` segment followed by a secret then `@`.
const CREDENTIAL_URL_PATTERN = /(https?:\/\/)([^\s/@]+:)?[^\s/@]+@/g

export function stripCredentialsFromMessage(message: string): string {
  return message.replace(CREDENTIAL_URL_PATTERN, '$1')
}

function extractTailLine(message: string): string {
  // Why: execFile rejections prefix the message with "Command failed: git ..."
  // followed by the full stderr. The meaningful diagnostic is typically the
  // last non-empty line; surfacing the full blob risks leaking local paths or
  // environment details to the UI.
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? message
}

export function normalizeGitErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Git remote operation failed.'
  }

  const raw = error.message

  if (raw.includes('non-fast-forward') || raw.includes('fetch first')) {
    // Why: this specific guidance tells users the safe recovery path instead
    // of surfacing raw git stderr that varies across git versions/locales.
    return 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  }

  if (raw.includes('could not read Username') || raw.includes('Authentication failed')) {
    return 'Authentication failed. Check your remote credentials.'
  }

  if (raw.includes('Could not resolve host') || raw.includes('Network is unreachable')) {
    return 'Network error. Check your connection.'
  }

  if (raw.includes('no tracking information') || raw.includes('no upstream')) {
    return 'Branch has no upstream. Publish the branch first.'
  }

  // Fallthrough: extract only the tail stderr line and scrub any embedded
  // credential before returning. See CREDENTIAL_URL_PATTERN comment above.
  return stripCredentialsFromMessage(extractTailLine(raw))
}

// Why: we only swallow clearly-no-upstream signals — an expected state, not a
// failure. Other errors ('not a git repository', 'corrupt', auth failures,
// sparse-checkout errors, etc.) must fall through to the caller so users can
// act on them. We explicitly avoid matching `HEAD@{u}` alone because execFile
// wraps errors with "Command failed: git rev-parse --abbrev-ref HEAD@{u}…",
// which would cause every non-repo/corrupt failure to spuriously look like
// no-upstream. We also do NOT match 'no such branch' — that phrase is too
// broad and can mask real errors on corrupt refs or sparse-checkout failures.
const NO_UPSTREAM_ERROR_PATTERN =
  /no upstream configured|no tracking information|HEAD does not point|Needed a single revision/i

export function isNoUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return NO_UPSTREAM_ERROR_PATTERN.test(error.message)
}
