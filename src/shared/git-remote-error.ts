import { isPushHookFailure } from './source-control-push-failure'

// Why: strip `user:password@` on any scheme, but a lone `user@` only on HTTP(S) — SSH's git@host user-info is required, so stripping breaks the URL.
const USERPASS_URL_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi
const HTTPS_TOKEN_URL_PATTERN = /(https?:\/\/)[^\s/@:]+@/gi
const SUBMODULE_PUSH_FAILURE_PATTERN = /Unable to push submodule ['"](.+?)['"]/i
const SUBMODULE_PUSH_FAILURE_SENTINEL_PATTERN =
  /failed to push all needed submodules|Unable to push submodule/i
const SUBMODULE_REMOTE_CHANGED_PATTERN =
  /non-fast-forward|fetch first|updates were rejected|remote contains work that you do not have/i
const NORMALIZED_SUBMODULE_PUSH_FAILURE_PATTERN =
  /(?:^|:\s)((?:Submodule '[^'\n]+'|A submodule) (?:has remote changes\. Pull inside the submodule, then try again\.|could not be pushed\. Resolve the submodule push error, then try again\.))(?:$|\s)/i
const DIVERGENT_PULL_RECONCILIATION_PATTERN =
  /Need to specify how to reconcile divergent branches|divergent branches and need to specify how to reconcile them/i
// Why: these args already pin a reconcile strategy; the merge fallback must not override an explicit choice like --ff-only.
const RECONCILIATION_PULL_ARG_PATTERN =
  /^(--rebase|--no-rebase|--ff-only|--ff|--no-ff|--merge|-r)(=|$)/
// Why: --no-rebase (historical merge default) predates the 2.25 baseline, so this fallback is safe on every supported Git.
export const MERGE_RECONCILIATION_PULL_ARGS = ['--no-rebase']

export function stripCredentialsFromMessage(message: string): string {
  return message.replace(USERPASS_URL_PATTERN, '$1').replace(HTTPS_TOKEN_URL_PATTERN, '$1')
}

export function formatSubmodulePushFailureDetail(message: string): string | null {
  const raw = stripCredentialsFromMessage(message)
  const trimmed = raw.trim()
  const normalizedMatch = trimmed.match(NORMALIZED_SUBMODULE_PUSH_FAILURE_PATTERN)
  if (normalizedMatch) {
    return normalizedMatch[1]
  }
  if (!SUBMODULE_PUSH_FAILURE_SENTINEL_PATTERN.test(trimmed)) {
    return null
  }

  // Why: recursive push hides the actionable nested rejection behind a top-level "failed to push all needed submodules" line.
  const submoduleName = trimmed.match(SUBMODULE_PUSH_FAILURE_PATTERN)?.[1]?.trim()
  const subject = submoduleName ? `Submodule '${submoduleName}'` : 'A submodule'
  if (SUBMODULE_REMOTE_CHANGED_PATTERN.test(trimmed)) {
    return `${subject} has remote changes. Pull inside the submodule, then try again.`
  }
  return `${subject} could not be pushed. Resolve the submodule push error, then try again.`
}

function extractTailLine(message: string): string {
  // Why: last non-empty stderr line is the diagnostic; the full blob risks leaking local paths/env to the UI.
  for (const rawLine of iterateLinesFromEnd(message)) {
    const line = rawLine.trim()
    if (line.length > 0) {
      return line
    }
  }
  return message
}

function* iterateLinesFromEnd(value: string): Generator<string> {
  let lineEnd = value.length
  let index = value.length - 1

  while (index >= 0) {
    const code = value.charCodeAt(index)
    if (code !== 10 && code !== 13) {
      index--
      continue
    }

    const delimiterStart =
      code === 10 && index > 0 && value.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield value.slice(index + 1, lineEnd)
    lineEnd = delimiterStart
    index = delimiterStart - 1
  }

  yield value.slice(0, lineEnd)
}

// Why: Git 2.27+ refuses divergent pulls when no pull.rebase/pull.ff policy is set; detected so callers can retry as merge.
export function isDivergentPullReconciliationError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }
  return DIVERGENT_PULL_RECONCILIATION_PATTERN.test(stripCredentialsFromMessage(error.message))
}

// Why: if the pull already specifies a reconcile strategy, the caller's choice must win over the merge fallback.
export function pullArgsSpecifyReconciliation(pullArgs: string[]): boolean {
  return pullArgs.some((arg) => RECONCILIATION_PULL_ARG_PATTERN.test(arg))
}

// Why: on hosts with no pull.rebase/pull.ff policy, Git 2.27+ refuses divergent pulls; retry as merge (Git's historical default).
// Not GitCapabilityCache-routed: this is per-repo config/branch state, not a stable host capability.
export async function runPullWithDivergenceFallback(
  pullArgs: string[],
  runPull: (effectiveArgs: string[]) => Promise<void>
): Promise<void> {
  try {
    await runPull(pullArgs)
  } catch (error) {
    if (!pullArgsSpecifyReconciliation(pullArgs) && isDivergentPullReconciliationError(error)) {
      await runPull([...MERGE_RECONCILIATION_PULL_ARGS, ...pullArgs])
      return
    }
    throw error
  }
}

export type GitRemoteOperation = 'push' | 'pull' | 'fetch' | 'upstream'

export function normalizeGitErrorMessage(error: unknown, operation?: GitRemoteOperation): string {
  if (!(error instanceof Error)) {
    return 'Git remote operation failed.'
  }

  // Why: scrub credentials up-front so every downstream branch operates on already-redacted text.
  const raw = stripCredentialsFromMessage(error.message)

  const submodulePushFailureDetail = formatSubmodulePushFailureDetail(raw)
  if ((operation === 'push' || operation === undefined) && submodulePushFailureDetail) {
    return submodulePushFailureDetail
  }

  // Why: `non-fast-forward`/`fetch first` also occur on fetch/pull, so gate this push-specific guidance to push.
  if (
    (operation === 'push' || operation === undefined) &&
    (raw.includes('non-fast-forward') || raw.includes('fetch first'))
  ) {
    return 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  }

  if (operation === 'push' && isPushHookFailure(raw)) {
    // Why: pre-push hook output is the actionable part, printed before git's generic "failed to push some refs" tail line.
    return raw.trim()
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

  if (operation === 'pull' && DIVERGENT_PULL_RECONCILIATION_PATTERN.test(raw)) {
    return (
      'Pull needs a Git pull policy for divergent branches. Configure one for this repository ' +
      'or host, then try again: git config pull.rebase false (merge), ' +
      'git config pull.rebase true (rebase), or git config pull.ff only (fast-forward only).'
    )
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

  // Fallthrough: raw was already credential-scrubbed at top, so just extract the tail stderr line.
  return extractTailLine(raw)
}

// Why: require a `fatal:` prefix so wrapped command text or hook/progress output can't spuriously match and mask real failures.
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
