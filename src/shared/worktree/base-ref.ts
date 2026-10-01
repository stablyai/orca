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
