/**
 * Extract the original branch from a git rebase `head-name` state file, or null when it
 * isn't a single-line `refs/heads/<branch>` value (e.g. the literal `detached HEAD` git
 * records for a rebase started detached, or a truncated/multi-line file).
 * Why: this is a shape check on git-generated input, not full check-ref-format
 * validation — a wrong value only misses a PR-cache lookup.
 */
export function parseRebaseHeadName(headName: string): string | null {
  const trimmed = headName.trim()
  if (!trimmed.startsWith('refs/heads/')) {
    return null
  }
  // Reject ASCII control chars and space: blocks multi-line/truncated values while
  // still allowing the non-ASCII whitespace git permits in ref names.
  for (let i = 0; i < trimmed.length; i += 1) {
    if (trimmed.charCodeAt(i) <= 0x20) {
      return null
    }
  }
  const branch = trimmed.slice('refs/heads/'.length)
  // Why: a bare `refs/heads/` (empty branch) would slice to '' and read as a live branch,
  // poisoning PR lookups just like a corrupt value; treat it as unrecoverable.
  return branch.length > 0 ? branch : null
}
