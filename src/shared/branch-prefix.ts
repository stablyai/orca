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

/** Share strategy-to-raw-prefix selection between branch creation and live settings feedback; null disables prefixing. */
export function selectBranchPrefixInput(
  settings: Omit<BranchPrefixSettings, 'branchPrefix'> & { branchPrefix: string },
  gitUsername: string | null
): string | null | void {
  switch (settings.branchPrefix) {
    case 'git-username': {
      // Lowercase a mixed-case login. If that form is a ref git rejects, omit the prefix.
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

/** Normalize whitespace/slash runs before prefix/leaf joining to avoid Git-invalid team//name while preserving multi-segment prefixes. */
export function normalizeBranchPrefix(rawPrefix: string): string {
  return rawPrefix
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
}

// Ref-reserved characters git check-ref-format rejects inside a branch name.
const INVALID_BRANCH_PREFIX_CHARS = /[~^:?*[\\]/

/** Check ASCII controls/spaces by code point, matching sanitizeWorktreeDisplayName without a forbidden control regex. */
function hasControlOrSpace(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0)
    return code <= 0x20 || code === 0x7f
  })
}

/** Mirror relevant check-ref-format rules for live feedback, returning translatable reason codes. Git remains authoritative during creation. */
export function getBranchPrefixIssue(rawPrefix: string): 'invalid-characters' | null {
  const normalized = normalizeBranchPrefix(rawPrefix)
  if (!normalized) {
    // Empty after normalization means "no prefix" — valid.
    return null
  }
  // Match Git rules without overrejecting valid mid-segment dots/hyphens: forbid controls/spaces/reserved chars, .., @{, leading -, trailing ., dot-leading segments and .lock suffixes.
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

/** Fail configured prefixes early on worktree creation with clear errors instead of later check-ref-format failures. */
export function assertBranchPrefixValid(prefix: string): void {
  if (getBranchPrefixIssue(prefix) !== null) {
    throw new Error(
      `Branch prefix "${prefix}" contains characters git rejects — update it in Settings → Git`
    )
  }
}
