export type WorktreeBaseRefExists = (qualifiedRef: string) => Promise<boolean>

export async function resolveWorktreeAddBaseRef(
  baseRef: string,
  refExists: WorktreeBaseRefExists
): Promise<string> {
  if (baseRef.startsWith('refs/')) {
    return baseRef
  }

  // Why: `git worktree add` receives a revision, so short names can collide
  // with tags. Prefer the namespace implied by Orca's base picker: remote
  // display names like `origin/main` first, otherwise local branches.
  const candidates = baseRef.includes('/')
    ? [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`]
    : [`refs/heads/${baseRef}`]

  for (const candidate of candidates) {
    if (await refExists(candidate)) {
      return candidate
    }
  }

  return baseRef
}

/**
 * The branch identity two base refs share when one is the local branch and the
 * other is a remote-tracking copy of it: `refs/heads/main` and
 * `refs/remotes/origin/main` both return `main`.
 *
 * Bounds the prepared-checkout retarget. A prepared checkout may only be reused
 * for a different base when both name the same branch, so the retarget reset is
 * bounded by that branch's drift across remotes rather than by an arbitrary
 * divergence. Anything unqualified — a bare name, a commit id — has no family.
 */
export function worktreeBaseRefFamily(qualifiedRef: string): string | null {
  if (qualifiedRef.startsWith('refs/heads/')) {
    return qualifiedRef.slice('refs/heads/'.length) || null
  }
  if (qualifiedRef.startsWith('refs/remotes/')) {
    const withoutRemote = qualifiedRef.slice('refs/remotes/'.length)
    const separator = withoutRemote.indexOf('/')
    if (separator <= 0) {
      return null
    }
    const branch = withoutRemote.slice(separator + 1)
    // `refs/remotes/<remote>/HEAD` is a symbolic pointer, not a branch identity.
    return branch && branch !== 'HEAD' ? branch : null
  }
  return null
}
