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
const SUBMODULE_PUSH_FAILURE_PATTERN = /Unable to push submodule ['"](.+?)['"]/i
const SUBMODULE_PUSH_FAILURE_SENTINEL_PATTERN =
  /failed to push all needed submodules|Unable to push submodule/i
const SUBMODULE_REMOTE_CHANGED_PATTERN =
  /non-fast-forward|fetch first|updates were rejected|remote contains work that you do not have/i
const NORMALIZED_SUBMODULE_PUSH_FAILURE_PATTERN =
  /(?:^|:\s)((?:Submodule '[^'\n]+'|A submodule) (?:has remote changes\. Pull inside the submodule, then try again\.|could not be pushed\. Resolve the submodule push error, then try again\.))(?:$|\s)/i

export function stripCredentialsFromMessage(message: string): string {
  return message.replace(USERPASS_URL_PATTERN, '$1').replace(HTTPS_TOKEN_URL_PATTERN, '$1')
}

export function formatSubmodulePushFailureDetail(message: string): string | null {
  const raw = stripCredentialsFromMessage(message)
  const normalized = raw.replace(/\r\n/g, '\n').trim()
  const normalizedMatch = normalized.match(NORMALIZED_SUBMODULE_PUSH_FAILURE_PATTERN)
  if (normalizedMatch) {
    return normalizedMatch[1]
  }
  if (!SUBMODULE_PUSH_FAILURE_SENTINEL_PATTERN.test(normalized)) {
    return null
  }

  // Why: recursive push can hide the actionable nested rejection behind a
  // top-level "failed to push all needed submodules" fatal line.
  const submoduleName = normalized.match(SUBMODULE_PUSH_FAILURE_PATTERN)?.[1]?.trim()
  const subject = submoduleName ? `Submodule '${submoduleName}'` : 'A submodule'
  if (SUBMODULE_REMOTE_CHANGED_PATTERN.test(normalized)) {
    return `${subject} has remote changes. Pull inside the submodule, then try again.`
  }
  return `${subject} could not be pushed. Resolve the submodule push error, then try again.`
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

  const submodulePushFailureDetail = formatSubmodulePushFailureDetail(raw)
  if ((operation === 'push' || operation === undefined) && submodulePushFailureDetail) {
    return submodulePushFailureDetail
  }

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

  if (
    raw.includes('Your local changes to the following files would be overwritten') ||
    raw.includes('Your local changes would be overwritten')
  ) {
    return 'Pull would overwrite local changes. Commit, stash, or discard them before pulling.'
  }

  if (raw.includes('untracked working tree files would be overwritten')) {
    return 'Pull would overwrite untracked files. Move, remove, or add them before pulling.'
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
