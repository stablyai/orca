export function terminalOwnerRows(environmentId: string | null) {
  return {
    repos: [
      {
        id: 'repo-1',
        executionHostId: environmentId ? `runtime:${environmentId}` : undefined,
        connectionId: null
      }
    ],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
  }
}
