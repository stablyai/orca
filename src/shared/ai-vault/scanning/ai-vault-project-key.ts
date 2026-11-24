// One spelling, so a key minted on a client and matched on the host cannot drift.
export function toAiVaultProjectKey(
  projectId: string | null | undefined,
  repoId?: string | null
): string | null {
  if (projectId) {
    // Legacy projections already use repo-prefixed ids; wrapping one again splits the key.
    return projectId.startsWith('repo:') ? projectId : `project:${projectId}`
  }
  return repoId ? `repo:${repoId}` : null
}
