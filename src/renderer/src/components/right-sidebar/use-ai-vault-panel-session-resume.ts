import { useCallback } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { AppState } from '@/store/types'
import {
  resolveAiVaultHistorySessionResumeState,
  resolveAiVaultSessionResumeActions,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultHistoryRowResume } from './ai-vault-session-resume-in-chat-workspace'
import {
  useAiVaultSessionOwnerWorkspaces,
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from './ai-vault-session-worktree'

/** Where each listed session lives and where it would resume, relative to the panel's workspace. */
export function useAiVaultPanelSessionResume(args: {
  sessions: readonly AiVaultSession[]
  repos: readonly Repo[]
  allWorktrees: readonly Worktree[]
  workspaceId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
  settings: AppState['settings']
}) {
  const { sessions, repos, allWorktrees, workspaceId, resumeTargetState, settings } = args
  // Folder workspaces own their sessions by cwd too, so they resume and jump like a worktree.
  const ownerWorkspaces = useAiVaultSessionOwnerWorkspaces(allWorktrees, resumeTargetState)
  const sessionWorktreeById = useAiVaultSessionWorktreeMap({
    sessions,
    repos,
    worktrees: ownerWorkspaces
  })
  // `current` is stamped per row at read time so the map above stays cached.
  const getSessionWorktreeInfo = useCallback(
    (session: AiVaultSession) =>
      withAiVaultCurrentWorktreeStatus(sessionWorktreeById.get(session.id) ?? null, workspaceId),
    [workspaceId, sessionWorktreeById]
  )
  const getSessionRowResumeArgs = useCallback(
    (session: AiVaultSession) => ({
      session,
      worktreeInfo: getSessionWorktreeInfo(session),
      activeWorktreeId: workspaceId,
      worktrees: ownerWorkspaces,
      repos,
      targetState: resumeTargetState
    }),
    [workspaceId, getSessionWorktreeInfo, ownerWorkspaces, repos, resumeTargetState]
  )
  const getSessionResumeState = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultHistorySessionResumeState(getSessionRowResumeArgs(session)),
    [getSessionRowResumeArgs]
  )
  const getSessionResumeActions = useCallback(
    (session: AiVaultSession) =>
      resolveAiVaultSessionResumeActions({
        ...getSessionRowResumeArgs(session),
        sessionFilePath: session.filePath,
        sessionExecutionHostId: session.executionHostId
      }),
    [getSessionRowResumeArgs]
  )
  // Resuming into a chat asks a different question from resuming into a terminal: not "can this
  // workspace host a PTY" but "will the provider still find this conversation from the workspace we
  // would run it in". The workspace it targets is the session's own when that is open, because
  // Claude looks its transcript up under a directory derived from the launch cwd.
  const getSessionResumeInChat = useCallback(
    (session: AiVaultSession): AiVaultResumeInChatEligibility =>
      resolveAiVaultHistoryRowResume({ ...getSessionRowResumeArgs(session), settings })
        .resumeInChat,
    [getSessionRowResumeArgs, settings]
  )
  return {
    getSessionWorktreeInfo,
    getSessionResumeState,
    getSessionResumeActions,
    getSessionResumeInChat
  }
}
