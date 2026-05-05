// Why: git's stderr often embeds the full remote URL, which can include a
// credential. Redact carefully: classic `user:password@` forms always carry
// a credential on any scheme (HTTPS, ssh://, git://, git+ssh://), but a
// lone `user@` is a credential ONLY for HTTP(S) (e.g. token-only PATs like
// `https://ghp_xxx@host`). For `ssh://git@host/...` the `git` login is
// required by the SSH remote — stripping it would produce a broken URL in
// the surfaced error and hide which remote actually failed. The two
// scheme-scoped patterns below keep SSH user-info intact while still
// scrubbing passwords on any scheme and HTTPS token-only forms.
const USERPASS_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const HTTPS_TOKEN_URL_PATTERN = /(https?:\/\/)[^\s/@:]+@/gi

export function stripCredentialsFromMessage(message: string): string {
  return message.replace(USERPASS_URL_PATTERN, '$1').replace(HTTPS_TOKEN_URL_PATTERN, '$1')
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

export type GitRemoteOperation = 'push' | 'pull' | 'fetch' | 'upstream'

export function normalizeGitErrorMessage(error: unknown, operation?: GitRemoteOperation): string {
  if (!(error instanceof Error)) {
    return 'Git remote operation failed.'
  }

  // Why: scrub credentials up-front so every downstream branch — including
  // any future refactor that returns a substring of `raw` — operates on
  // already-redacted text. The fast-path branches below return fixed
  // literals today, but this hardens against accidental leakage later.
  const raw = stripCredentialsFromMessage(error.message)

  // Why: `non-fast-forward` / `fetch first` can appear on fetch (after a
  // remote force-push updating a tracking ref) and on pull (with
  // `pull.ff=only`), so the "pull or sync first" guidance only makes sense
  // when the user was actually pushing. For other operations, fall through
  // to the generic tail-line path. `operation === undefined` keeps the
  // legacy push-shaped message for any caller that hasn't been updated yet.
  if (
    (operation === 'push' || operation === undefined) &&
    (raw.includes('non-fast-forward') || raw.includes('fetch first'))
  ) {
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

  // Fallthrough: extract only the tail stderr line. `raw` was already
  // credential-scrubbed at the top of the function, so no further scrub needed.
  return extractTailLine(raw)
}

// Why: we only swallow clearly-no-upstream signals — an expected state, not a
// failure. Other errors ('not a git repository', 'corrupt', auth failures,
// sparse-checkout errors, etc.) must fall through to the caller so users can
// act on them. We explicitly avoid matching `HEAD@{u}` alone because execFile
// wraps errors with "Command failed: git rev-parse --abbrev-ref HEAD@{u}…",
// which would cause every non-repo/corrupt failure to spuriously look like
// no-upstream. We also do NOT match 'no such branch' — that phrase is too
// broad and can mask real errors on corrupt refs or sparse-checkout failures.
// Additionally gate the phrase match on a `fatal:` prefix: git always
// prefixes these diagnostics with `fatal:`, so requiring it prevents
// `HEAD does not point` / `Needed a single revision` from matching unrelated
// output (e.g. hook stdout, progress lines) and silently hiding real
// corrupt-repo / unborn-HEAD / ambiguous-ref failures behind a spurious
// "0 ahead / 0 behind, no upstream" UI state. The one ambiguous-ref
// exception is HEAD@{u}: git emits it when branch config points at a
// tracking ref that is missing locally, which is the same expected UX state.
const NO_UPSTREAM_PHRASE_PATTERN =
  /no upstream configured|no tracking information|HEAD does not point|Needed a single revision|ambiguous argument 'HEAD@\{u\}'/i
const FATAL_PREFIX_PATTERN = /(^|\n)fatal:/i

export function isNoUpstreamError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  const message = error.message
  return FATAL_PREFIX_PATTERN.test(message) && NO_UPSTREAM_PHRASE_PATTERN.test(message)
}
