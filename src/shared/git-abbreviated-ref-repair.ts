/**
 * Repair abbreviated ref names that git truncated mid-UTF-8.
 *
 * Git derives every abbreviated form (`%(refname:short)`, `%(upstream:short)`,
 * `rev-parse --abbrev-ref`, `symbolic-ref --short`) in shorten_unambiguous_ref()
 * via sscanf("%s"), which stops at the first byte libc calls whitespace. Under a
 * UTF-8 LC_CTYPE macOS libc calls 0xA0 whitespace, so a ref whose encoding
 * contains that byte -- `渠` is E6 B8 A0 -- comes back cut mid-sequence.
 *
 * UNTRANSLATED_GIT_OUTPUT_ENV pins a C LC_CTYPE so Orca-spawned git does not hit
 * this. This module is the second line of defence, for refs read where that env
 * does not reach (an SSH host's own git, a relay on another libc) and for any
 * other libc that classifies a UTF-8 continuation byte as whitespace.
 *
 * Only ever extends the name git returned: `%(refname)` carries the full bytes,
 * and the abbreviated form is always a suffix of it, so the shortest suffix that
 * still starts with the truncated value restores the intended name. A ref that
 * was not truncated is returned unchanged, including git's significant
 * disambiguation prefixes (`heads/`, `remotes/`).
 */

// Longest first so `refs/heads/x` prefers `x` over `heads/x` when both start with the truncated value.
const REF_NAMESPACE_PREFIXES = ['refs/heads/', 'refs/remotes/', 'refs/tags/', 'refs/'] as const

/** A cut mid-sequence decodes to a trailing U+FFFD, which matches nothing in the intact name. */
function withoutTrailingReplacementChars(value: string): string {
  return value.replace(/�+$/, '')
}

/**
 * True when git's abbreviated output bears the mark of a mid-UTF-8 cut.
 *
 * 0xA0 is never a UTF-8 lead byte, so a cut there always severs a sequence whose
 * lead byte is already in the kept prefix -- which Node decodes to a trailing
 * U+FFFD. Callers use this to fetch the full `%(refname)` only when it can help,
 * instead of spending a git spawn on every ASCII ref.
 */
export function looksTruncatedMidUtf8(abbreviatedRef: string): boolean {
  return abbreviatedRef.endsWith('�')
}

/**
 * Recover the abbreviated name for `fullRef` when `abbreviatedRef` was cut short.
 *
 * `fullRef` must be git's own `%(refname)` (or `--symbolic-full-name`) output for
 * the same ref; an unrelated pair leaves `abbreviatedRef` untouched.
 */
export function repairAbbreviatedRefName(fullRef: string, abbreviatedRef: string): string {
  if (!fullRef || !abbreviatedRef || fullRef.endsWith(abbreviatedRef)) {
    return abbreviatedRef
  }
  const truncatedPrefix = withoutTrailingReplacementChars(abbreviatedRef)
  if (!truncatedPrefix) {
    return abbreviatedRef
  }
  const candidates = REF_NAMESPACE_PREFIXES.filter((prefix) => fullRef.startsWith(prefix)).map(
    (prefix) => fullRef.slice(prefix.length)
  )
  return (
    [...candidates, fullRef].find((candidate) => candidate.startsWith(truncatedPrefix)) ??
    abbreviatedRef
  )
}

/** Strip `refs/heads/` so a full branch ref reads as the branch name git meant to abbreviate. */
export function readBranchNameFromFullRef(fullRef: string): string | null {
  const branchName = fullRef.trim()
  return branchName.startsWith('refs/heads/')
    ? branchName.slice('refs/heads/'.length) || null
    : branchName || null
}
