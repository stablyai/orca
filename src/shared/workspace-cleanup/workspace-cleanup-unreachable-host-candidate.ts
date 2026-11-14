import { getRepoRoutingConnectionId, type ExecutionHostId } from '../execution-host'
import type { Repo } from '../repo-types'
import {
  createWorkspaceCleanupFingerprint,
  getWorkspaceCleanupInactivityReasons,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'
import {
  getNewestWorkspaceCleanupDiffCommentAt,
  type WorkspaceCleanupDiffCommentTimes
} from './workspace-cleanup-candidate-fields'

/** What a client still knows about a workspace whose host it cannot reach. */
export type UnreachableHostCleanupWorkspace = {
  worktreeId: string
  path: string
  displayName: string
  branch: string
  isArchived: boolean
  lastActivityAt: number
  lastTerminalUseAt?: number
  createdAt?: number
  diffComments?: WorkspaceCleanupDiffCommentTimes
}

/** A terminal used on any device counts, even while its host is unreachable. Unlike the live scan, createdAt is not counted. */
function getUnreachableHostCleanupActivityAt(
  workspace: Pick<UnreachableHostCleanupWorkspace, 'lastActivityAt' | 'lastTerminalUseAt'>
): number {
  const usedAt = workspace.lastTerminalUseAt
  return usedAt !== undefined && Number.isFinite(usedAt) && usedAt > workspace.lastActivityAt
    ? usedAt
    : workspace.lastActivityAt
}

/** A row Git cannot inspect: shown as "Remote unavailable" and never queued for removal. */
export function createUnreachableHostCleanupCandidate(
  repo: Pick<Repo, 'id' | 'displayName' | 'connectionId' | 'executionHostId'>,
  executionHostId: ExecutionHostId,
  workspace: UnreachableHostCleanupWorkspace,
  scannedAt: number
): WorkspaceCleanupCandidate {
  const lastActivityAt = getUnreachableHostCleanupActivityAt(workspace)
  return {
    worktreeId: workspace.worktreeId,
    repoId: repo.id,
    repoName: repo.displayName,
    connectionId: getRepoRoutingConnectionId(repo),
    executionHostId,
    displayName: workspace.displayName,
    branch: workspace.branch,
    path: workspace.path,
    reasons: getWorkspaceCleanupInactivityReasons(
      { isArchived: workspace.isArchived, lastActivityAt },
      scannedAt
    ),
    blockers: ['ssh-disconnected'],
    lastActivityAt,
    ...(workspace.createdAt !== undefined ? { createdAt: workspace.createdAt } : {}),
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: workspace.diffComments?.length ?? 0,
      newestDiffCommentAt: getNewestWorkspaceCleanupDiffCommentAt(workspace.diffComments),
      retainedDoneAgentCount: 0
    },
    git: {
      clean: null,
      upstreamAhead: null,
      upstreamBehind: null,
      checkedAt: null
    },
    fingerprint: createWorkspaceCleanupFingerprint({
      branch: workspace.branch,
      head: '',
      gitClean: null,
      lastActivityAt
    })
  }
}
