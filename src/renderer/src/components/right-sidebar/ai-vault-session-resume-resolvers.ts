import { useCallback } from 'react'
import type { Repo, Worktree } from '../../../../shared/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  resolveAiVaultSessionResumeActions,
  resolveAiVaultSessionResumeState,
  type AiVaultSessionResumeActions,
  type AiVaultSessionResumeState,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AiVaultSessionWorktreeInfo } from './ai-vault-session-worktree'

// Bundles the AI Vault's resume-target resolution: the session-row resolvers and
// the timeline's "click a prompt to resume its conversation" action, which share
// the same worktree/repo lookup inputs.
export function useAiVaultSessionResumeResolvers(args: {
  sessionWorktreeById: ReadonlyMap<string, AiVaultSessionWorktreeInfo>
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly Repo[]
  targetState: AiVaultSessionResumeTargetState
  onResume: (session: AiVaultSession, targetWorktreeId?: string) => void
}): {
  getSessionResumeState: (session: AiVaultSession) => AiVaultSessionResumeState
  getSessionResumeActions: (session: AiVaultSession) => AiVaultSessionResumeActions
  resumePromptSession: (session: AiVaultSession) => void
} {
  const { sessionWorktreeById, activeWorktreeId, worktrees, repos, targetState, onResume } = args

  const buildResolverArgs = useCallback(
    (session: AiVaultSession) => ({
      sessionFilePath: session.filePath,
      sessionExecutionHostId: session.executionHostId,
      worktreeInfo: sessionWorktreeById.get(session.id) ?? null,
      activeWorktreeId,
      worktrees,
      repos,
      targetState
    }),
    [activeWorktreeId, repos, sessionWorktreeById, targetState, worktrees]
  )

  const getSessionResumeState = useCallback(
    (session: AiVaultSession) => resolveAiVaultSessionResumeState(buildResolverArgs(session)),
    [buildResolverArgs]
  )

  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) => resolveAiVaultSessionResumeActions(buildResolverArgs(session)),
    [buildResolverArgs]
  )

  // Mirror the session row's primary resume: prefer the resolved worktree, then a
  // new tab. Always call onResume (even with no target) so handleResume surfaces
  // the "open a workspace" / unsupported toast instead of the click no-op'ing.
  const resumePromptSession = useCallback(
    (session: AiVaultSession) => {
      const state = getSessionResumeState(session)
      if (state.worktreeId) {
        onResume(session, state.worktreeId)
        return
      }
      const actions = getSessionResumeActions(session)
      onResume(session, actions.worktree.worktreeId ?? actions.newTab.worktreeId ?? undefined)
    },
    [getSessionResumeActions, getSessionResumeState, onResume]
  )

  return { getSessionResumeState, getSessionResumeActions, resumePromptSession }
}
