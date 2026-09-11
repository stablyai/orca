import { useCallback } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState,
  type AiVaultSessionResumeActions,
  type AiVaultSessionResumeState,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'

export function useAiVaultSessionResumeLookups({
  getSessionWorktreeInfo,
  activeWorktreeId,
  worktrees,
  repos,
  targetState
}: {
  getSessionWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState: AiVaultSessionResumeTargetState
}): {
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
} {
  const getSessionResumeState = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeState({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId,
        worktrees,
        repos,
        targetState
      }),
    [activeWorktreeId, getSessionWorktreeInfo, repos, targetState, worktrees]
  )

  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeActions({
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId,
        worktrees,
        repos,
        targetState
      }),
    [activeWorktreeId, getSessionWorktreeInfo, repos, targetState, worktrees]
  )

  return { getSessionResumeState, getSessionResumeActions }
}
