export const GIT_GRAPH_TAB_LABEL = 'Git Graph'

// Why: one graph tab per workspace — the view always renders live repo state,
// so reopening must focus the existing tab instead of stacking duplicates.
export function buildGitGraphTabId(worktreeId: string): string {
  return `${worktreeId}::git-graph`
}
