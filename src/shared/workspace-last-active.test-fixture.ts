import type { WorkspaceCleanupCandidate } from './workspace-cleanup'

export function makeCleanupCandidate(
  overrides: Pick<WorkspaceCleanupCandidate, 'lastActivityAt' | 'reasons'>
): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'repo::/w',
    repoId: 'repo',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'w',
    branch: 'w',
    path: '/w',
    tier: 'ready',
    selectedByDefault: true,
    blockers: [],
    localContext: {
      terminalTabCount: 1,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1 },
    fingerprint: 'f',
    ...overrides
  }
}
