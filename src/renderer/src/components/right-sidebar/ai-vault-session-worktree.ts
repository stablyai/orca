import { useMemo } from 'react'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  buildAiVaultSessionWorktreeMap,
  type AiVaultSessionWorktreeInfo
} from '../../../../shared/ai-vault-session-worktree'

export {
  aiVaultWorktreeCompactPath,
  canJumpToAiVaultSessionWorktree,
  resolveAiVaultSessionWorktreeDisplay,
  resolveAiVaultSessionWorktreeInfo,
  withAiVaultCurrentWorktreeStatus,
  type AiVaultSessionWorktreeInfo,
  type AiVaultSessionWorktreeStatus
} from '../../../../shared/ai-vault-session-worktree'
export {
  aiVaultResumeInSessionWorkspaceLabel,
  aiVaultSessionWorkspaceHeading,
  aiVaultWorktreeJumpTooltip,
  aiVaultWorktreeStatusLabel,
  isAiVaultFolderWorkspaceId,
  isAiVaultSessionInCurrentWorktree,
  shouldShowAiVaultSessionWorktreeLine,
  shouldShowAiVaultWorktreeStatusBadge
} from './ai-vault-session-worktree-affordances'

/** Include worktrees and folder: rows; put git first to win equal-path ties in the stable sort. */
export function aiVaultSessionOwnerWorkspaces(
  worktrees: readonly Worktree[],
  folderWorkspaces: readonly FolderWorkspace[]
): readonly Worktree[] {
  return folderWorkspaces.length === 0
    ? worktrees
    : [...worktrees, ...folderWorkspaces.map(folderWorkspaceToWorktree)]
}

export function useAiVaultSessionOwnerWorkspaces(
  worktrees: readonly Worktree[],
  { folderWorkspaces }: { folderWorkspaces: readonly FolderWorkspace[] }
): readonly Worktree[] {
  return useMemo(
    () => aiVaultSessionOwnerWorkspaces(worktrees, folderWorkspaces),
    [folderWorkspaces, worktrees]
  )
}

/** Keep active-worktree state out of this map; callers stamp current per row to avoid rebuilding candidates × sessions. */
export function useAiVaultSessionWorktreeMap({
  sessions,
  repos = [],
  worktrees
}: {
  sessions: readonly AiVaultSession[]
  repos?: readonly Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>[]
  worktrees: readonly Worktree[]
}): ReadonlyMap<string, AiVaultSessionWorktreeInfo> {
  return useMemo(
    () => buildAiVaultSessionWorktreeMap({ sessions, repos, worktrees }),
    [repos, sessions, worktrees]
  )
}
