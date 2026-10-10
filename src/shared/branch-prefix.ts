import type { BranchPrefixStrategy } from './ui-chrome-types'

/** The branch-prefix settings slice the prefix helpers read. */
export type BranchPrefixSettings = {
  branchPrefix: BranchPrefixStrategy
  branchPrefixCustom?: string
}

/** A configured login was not used because its lowercase form is a rejected ref. */
export type GitUsernamePrefixOmission = 'lowercase-lock'

/**
 * Why Settings omits a git username. Only a mixed-case login whose lowercase
 * form git rejects (`.LOCK` → `.lock`) is omitted. An already-lowercase invalid
 * login stays visible so the existing character warning still explains it.
 */
export function gitUsernamePrefixOmission(
  gitUsername: string | null
): GitUsernamePrefixOmission | null {
  if (gitUsername === null) {
    return null
  }
  const lower = gitUsername.toLowerCase()
  if (lower === gitUsername || getBranchPrefixIssue(lower) === null) {
    return null
  }
  if (getBranchPrefixIssue(gitUsername) !== null) {
    return null
  }
  return 'lowercase-lock'
}

/**
 * Pick the value the configured strategy contributes, or null when no prefix
 * applies. Shared so the main-process branch builder and the renderer's live
 * settings feedback agree on which field each strategy uses.
 *
 * A git username is lowercased so a mixed-case login cannot collide with an
 * existing lowercase ref directory on a case-insensitive filesystem. When that
 * lowercase form is a ref git rejects (`Alice.LOCK` becomes `alice.lock`), drop
 * the prefix. Keeping the original login creates `refs/heads/Alice.LOCK/`, which
 * occupies the `alice.lock` lockfile path on a case-insensitive filesystem.
 */
export function selectBranchPrefixInput(
  settings: BranchPrefixSettings,
  gitUsername: string | null
): string | null {
  switch (settings.branchPrefix) {
    case 'git-username': {
      if (gitUsername === null) {
        return null
      }
      const lower = gitUsername.toLowerCase()
      if (getBranchPrefixIssue(lower) === null) {
        return lower
      }
      // The original can pass git's case-sensitive check while its lowercase
      // form is `*.lock`. Keeping that original still collides on a
      // case-insensitive filesystem, so the prefix is omitted. An
      // already-lowercase invalid login is returned unchanged so settings can
      // show the rejection instead of pretending no username was configured.
      if (gitUsernamePrefixOmission(gitUsername) === 'lowercase-lock') {
        return null
      }
      return lower
    }
    case 'custom':
      return settings.branchPrefixCustom ?? null
    case 'none':
      return null
  }
}

/**
 * Normalize a configured branch prefix into the segment that gets prepended
 * before the `/` separator when building a branch name.
 *
 * Why: the branch-name join (`${prefix}/${leaf}`) already inserts a single `/`,
 * so a user-typed prefix like `team/` would otherwise yield `team//name`, which
 * git check-ref-format rejects. Strip surrounding whitespace and slashes and
 * collapse internal runs so the join always produces exactly one separator.
 * Legitimate multi-segment prefixes (e.g. `team/frontend`) are preserved.
 */
export function normalizeBranchPrefix(rawPrefix: string): string {
  return rawPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

// Ref-reserved characters git check-ref-format rejects inside a branch name.
const INVALID_BRANCH_PREFIX_CHARS = /[~^:?*[\\]/

/**
 * Whether the value contains an ASCII control character or space, both of which
 * git rejects. Checked by code point (like `sanitizeWorktreeDisplayName`) to
 * avoid a control-character regex that the linter forbids.
 */
function hasControlOrSpace(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
}

/**
 * Detect whether a branch prefix, after normalization, still contains characters
 * git check-ref-format rejects. Returns a reason code (not a UI string, so the
 * renderer owns translation) or null when the prefix is usable.
 *
 * This is a lightweight mirror of the relevant check-ref-format rules for live
 * settings feedback; git remains the source of truth at worktree-create time.
 */
export function getBranchPrefixIssue(rawPrefix: string): 'invalid-characters' | null {
  const normalized = normalizeBranchPrefix(rawPrefix)
  if (!normalized) {
    // Empty after normalization means "no prefix" — valid.
    return null
  }
  // Mirror git check-ref-format exactly so we don't reject prefixes git accepts:
  // control chars/space, the ref-reserved set, `..`, and `@{` are forbidden
  // anywhere; the whole ref may not start with `-` (arg-injection / leading-dash)
  // nor end with `.`; and each `/`-segment may not start with `.` nor end with
  // `.lock`. Hyphens and mid-segment dots elsewhere are fine (e.g. `team./x`).
  if (
    hasControlOrSpace(normalized) ||
    INVALID_BRANCH_PREFIX_CHARS.test(normalized) ||
    normalized.includes('..') ||
    normalized.includes('@{') ||
    normalized.startsWith('-') ||
    normalized.endsWith('.') ||
    normalized.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock'))
  ) {
    return 'invalid-characters'
  }
  return null
}

/**
 * Fail fast when a configured prefix would produce a branch name git rejects.
 * Used on the main-process worktree-create path so users get a clear error
 * instead of an opaque check-ref-format failure later.
 */
export function assertBranchPrefixValid(prefix: string): void {
  if (getBranchPrefixIssue(prefix) !== null) {
    throw new Error(
      `Branch prefix "${prefix}" contains characters git rejects — update it in Settings → Git`
    )
  }
}
