import { useCallback, useMemo } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { buildAiVaultSessionProjectById } from './ai-vault-session-projects'
import {
  useAiVaultSessionWorktreeMap,
  withAiVaultCurrentWorktreeStatus
} from './ai-vault-session-worktree'

type SessionProjectInput = Parameters<typeof buildAiVaultSessionProjectById>[0]
type SessionWorktreeInput = Parameters<typeof useAiVaultSessionWorktreeMap>[0]

export function useAiVaultSessionDisplayContext({
  sessions,
  repos,
  worktrees,
  projectHostSetupProjection,
  effectiveActiveWorktreeId
}: Pick<SessionProjectInput, 'repos' | 'worktrees' | 'projectHostSetupProjection'> &
  Pick<SessionWorktreeInput, 'sessions'> & {
    effectiveActiveWorktreeId: Parameters<typeof withAiVaultCurrentWorktreeStatus>[1]
  }) {
  const sessionProjectById = useMemo(
    () =>
      buildAiVaultSessionProjectById({
        repos,
        worktrees,
        projectHostSetupProjection,
        sessions
      }),
    [projectHostSetupProjection, repos, sessions, worktrees]
  )
  const sessionWorktreeById = useAiVaultSessionWorktreeMap({ sessions, repos, worktrees })
  const getSessionWorktreeInfo = useCallback(
    (session: AiVaultSession) =>
      withAiVaultCurrentWorktreeStatus(
        sessionWorktreeById.get(session.id) ?? null,
        effectiveActiveWorktreeId
      ),
    [effectiveActiveWorktreeId, sessionWorktreeById]
  )
  return { sessionProjectById, getSessionWorktreeInfo }
}
