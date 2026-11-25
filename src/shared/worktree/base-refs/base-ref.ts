export type WorktreeBaseRefExists = (qualifiedRef: string) => Promise<boolean>

export async function resolveWorktreeAddBaseRef(
  baseRef: string,
  refExists: WorktreeBaseRefExists
): Promise<string> {
  if (baseRef.startsWith('refs/')) {
    return baseRef
  }

  // Qualify base-picker revisions so tags cannot shadow branches: prefer remote refs for slash-containing names, local refs otherwise.
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

/** Return the common branch name for qualified local/remote refs (refs/heads/main and refs/remotes/origin/main). Prepared-checkout retargets stay within that family to bound drift; bare names/commit IDs have none. */
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
