import { useCallback } from 'react'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store/index'
import { selectAgentLaunchRouteView } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { useChatProgramFactsVersion } from '@/lib/host-chat-program-acquisition'
import { recomputeOn } from '@/lib/recompute-on'
import {
  resolveAiVaultHistorySessionResumeState,
  resolveAiVaultSessionResumeActions,
  type AiVaultSessionResumeTargetState
} from './ai-vault-session-resume'
import type { AiVaultResumeInChatEligibility } from './ai-vault-session-resume-in-chat'
import { resolveAiVaultHistoryRowResume } from './ai-vault-session-resume-in-chat-workspace'
import {
  useAiVaultSessionOwnerWorkspaces,
  useAiVaultSessionWorktreeMap
} from '../session-list/ai-vault-session-worktree'
import { withAiVaultCurrentWorktreeStatus } from '../../../../../../shared/ai-vault/session-display/ai-vault-session-worktree'

export function useAiVaultPanelSessionResume(args: {
  sessions: readonly AiVaultSession[]
  repos: readonly Repo[]
  allWorktrees: readonly Worktree[]
  workspaceId: string | null
  resumeTargetState: AiVaultSessionResumeTargetState
}) {
  const { sessions, repos, allWorktrees, workspaceId, resumeTargetState } = args
  // Folder workspaces also own sessions by cwd for resume and jump.
  const ownerWorkspaces = useAiVaultSessionOwnerWorkspaces(allWorktrees, resumeTargetState)
  const sessionWorktreeById = useAiVaultSessionWorktreeMap({
    sessions,
    repos,
    worktrees: ownerWorkspaces
  })
  // Stamp current per row to preserve the cached ownership map.
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
  // Chat resume must preserve the session’s workspace: Claude finds transcripts through launch-cwd-derived paths.
  const launchRoute = useAppStore(selectAgentLaunchRouteView)
  const chatProgramFactsVersion = useChatProgramFactsVersion()
  const getSessionResumeInChat = useCallback(
    (session: AiVaultSession): AiVaultResumeInChatEligibility =>
      // Eligibility reads the store and host agent caches outside its arguments; these track them.
      recomputeOn([launchRoute, chatProgramFactsVersion], () =>
        resolveAiVaultHistoryRowResume({
          ...getSessionRowResumeArgs(session),
          settings: launchRoute.settings
        })
      ).resumeInChat,
    [getSessionRowResumeArgs, launchRoute, chatProgramFactsVersion]
  )
  return {
    getSessionWorktreeInfo,
    getSessionResumeState,
    getSessionResumeActions,
    getSessionResumeInChat
  }
}
