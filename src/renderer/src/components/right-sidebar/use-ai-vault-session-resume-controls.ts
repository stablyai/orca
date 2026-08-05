import { useCallback } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo, Worktree } from '../../../../shared/types'
import { resolveAiVaultCursorCommand, type CursorCommandState } from '@/lib/ai-vault-cursor-command'
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'

export function useAiVaultSessionResumeControls({
  activeWorktreeId,
  worktrees,
  repos,
  targetState,
  cursorCommandOverride,
  getSessionWorktreeInfo
}: {
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState: AiVaultSessionResumeTargetState & CursorCommandState
  cursorCommandOverride?: string | null
  getSessionWorktreeInfo: (session: AiVaultSession) => AiVaultSessionWorktreeInfo | null
}): {
  getSessionResumeState: (
    session: AiVaultSession
  ) => ReturnType<typeof resolveAiVaultSessionResumeState>
  getSessionResumeActions: (
    session: AiVaultSession
  ) => ReturnType<typeof resolveAiVaultSessionResumeActions>
} {
  const cursorCommandAvailable = useCallback(
    (worktreeId: string | null): boolean =>
      Boolean(
        worktreeId &&
        resolveAiVaultCursorCommand({
          state: targetState,
          worktreeId,
          commandOverride: cursorCommandOverride
        })
      ),
    [cursorCommandOverride, targetState]
  )
  const getSessionResumeState = useCallback(
    (session: AiVaultSession) => {
      const state = resolveAiVaultSessionResumeState({
        sessionAgent: session.agent,
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId,
        worktrees,
        repos,
        targetState
      })
      return session.agent === 'cursor'
        ? {
            ...state,
            cursorCommandAvailable: cursorCommandAvailable(state.worktreeId)
          }
        : state
    },
    [
      activeWorktreeId,
      cursorCommandAvailable,
      getSessionWorktreeInfo,
      repos,
      targetState,
      worktrees
    ]
  )
  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) => {
      const actions = resolveAiVaultSessionResumeActions({
        sessionAgent: session.agent,
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId,
        worktreeInfo: getSessionWorktreeInfo(session),
        activeWorktreeId,
        worktrees,
        repos,
        targetState
      })
      if (session.agent !== 'cursor') {
        return actions
      }
      return {
        worktree: {
          ...actions.worktree,
          disabled:
            actions.worktree.disabled || !cursorCommandAvailable(actions.worktree.worktreeId)
        },
        newTab: {
          ...actions.newTab,
          disabled: actions.newTab.disabled || !cursorCommandAvailable(actions.newTab.worktreeId)
        }
      }
    },
    [
      activeWorktreeId,
      cursorCommandAvailable,
      getSessionWorktreeInfo,
      repos,
      targetState,
      worktrees
    ]
  )
  return { getSessionResumeState, getSessionResumeActions }
}
