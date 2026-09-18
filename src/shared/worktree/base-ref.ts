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
 * Bare local compare bases, including slash-containing names such as
 * `release/24`. Explicit remote pins (`origin/master`, `refs/remotes/...`)
 * stay untouched.
 */
export function localBranchNameForCompareBase(baseRef: string): string | null {
  const trimmed = baseRef.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length) || null
  }
  // Why: `origin/master` is already a remote-tracking pin. Other slash names
  // such as `release/24` are local branch paths and still need origin/.
  if (trimmed.startsWith('refs/') || trimmed.startsWith('origin/')) {
    return null
  }
  return trimmed
}

function isRemoteTrackingCompareBase(baseRef: string): boolean {
  const trimmed = baseRef.trim()
  if (trimmed.startsWith('refs/remotes/')) {
    return true
  }
  return !trimmed.startsWith('refs/') && trimmed.includes('/')
}

function compareBaseBranchFamily(baseRef: string): string | null {
  const trimmed = baseRef.trim()
  const localBranch = localBranchNameForCompareBase(trimmed)
  if (localBranch) {
    return localBranch
  }
  if (trimmed.startsWith('refs/')) {
    return worktreeBaseRefFamily(trimmed)
  }
  return trimmed.includes('/') ? worktreeBaseRefFamily(`refs/remotes/${trimmed}`) : null
}

/**
 * Prefer a remote-tracking copy of the same branch when the worktree pin is a
 * local default (`master`) and the repo/default pin is `origin/master`.
 */
export function preferRemoteTrackingCompareBase(
  worktreeBaseRef: string | null | undefined,
  remoteCandidate: string | null | undefined
): string | null {
  const worktree = worktreeBaseRef?.trim() || null
  const remote = remoteCandidate?.trim() || null
  if (!worktree) {
    return remote
  }
  if (
    remote &&
    localBranchNameForCompareBase(worktree) !== null &&
    isRemoteTrackingCompareBase(remote) &&
    compareBaseBranchFamily(worktree) === compareBaseBranchFamily(remote)
  ) {
    return remote
  }
  return worktree
}

/**
 * Qualify a committed-on-branch compare base. A stale local default branch is
 * not the merge-base when `origin/<branch>` still exists.
 */
export async function resolveBranchCompareBaseRef(
  baseRef: string,
  refExists: WorktreeBaseRefExists
): Promise<string> {
  const trimmed = baseRef.trim()
  const localBranch = localBranchNameForCompareBase(trimmed)
  if (localBranch) {
    const remoteTracking = `refs/remotes/origin/${localBranch}`
    if (await refExists(remoteTracking)) {
      return remoteTracking
    }
  }
  return resolveWorktreeAddBaseRef(trimmed, refExists)
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
