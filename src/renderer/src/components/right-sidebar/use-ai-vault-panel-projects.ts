import { aiVaultSearchScopeIdentity } from './ai-vault-search-scope-identity'
import { useMemo } from 'react'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { withAiVaultHistoryPreviews } from './ai-vault-search-session'
import {
  deriveAiVaultScopeSessionPaths,
  deriveAiVaultWorkspaceScopePaths
} from '../../../../shared/ai-vault-scope-paths'
import {
  buildAiVaultProjectContext,
  buildAiVaultSessionProjectById
} from './ai-vault-session-projects'

type ProjectContextArgs = Omit<Parameters<typeof buildAiVaultProjectContext>[0], 'sessions'>
type SessionProjectArgs = Omit<Parameters<typeof buildAiVaultSessionProjectById>[0], 'sessions'>

export function useAiVaultPanelSearchSessions(
  indexed: AiVaultSession[],
  history: readonly AiVaultSession[]
) {
  return useMemo(() => withAiVaultHistoryPreviews(indexed, history), [indexed, history])
}

export function useAiVaultPanelProjectContext({
  folderWorkspaces,
  repos,
  worktrees,
  projectHostSetupProjection,
  activeRepo,
  activeWorktree,
  settings
}: ProjectContextArgs) {
  const activeWorktreePaths = useMemo(
    () => deriveAiVaultWorkspaceScopePaths(activeWorktree, worktrees),
    [activeWorktree, worktrees]
  )
  const context = useMemo(
    () =>
      buildAiVaultProjectContext({
        folderWorkspaces,
        repos,
        worktrees,
        projectHostSetupProjection,
        activeRepo,
        activeWorktree,
        settings,
        sessions: []
      }),
    [
      activeRepo,
      activeWorktree,
      worktrees,
      projectHostSetupProjection,
      repos,
      folderWorkspaces,
      settings
    ]
  )
  return { ...context, activeWorktreePaths }
}

export function useAiVaultPanelSessionProjects(
  { folderWorkspaces, repos, worktrees, projectHostSetupProjection, settings }: SessionProjectArgs,
  history: readonly AiVaultSession[],
  indexed: readonly AiVaultSession[],
  searching: boolean,
  includeHistory: boolean
) {
  const sessions = useMemo(
    () => (searching ? (includeHistory ? [...history, ...indexed] : indexed) : history),
    [includeHistory, searching, history, indexed]
  )
  return useMemo(
    () =>
      buildAiVaultSessionProjectById({
        folderWorkspaces,
        repos,
        worktrees,
        projectHostSetupProjection,
        settings,
        sessions
      }),
    [worktrees, projectHostSetupProjection, repos, sessions, folderWorkspaces, settings]
  )
}

export function useAiVaultPanelScopePaths(
  worktree: Parameters<typeof deriveAiVaultScopeSessionPaths>[0],
  worktrees: Parameters<typeof deriveAiVaultScopeSessionPaths>[1],
  {
    scope,
    activeProjectKey,
    projectHostSetupProjection
  }: NonNullable<Parameters<typeof deriveAiVaultScopeSessionPaths>[2]>
) {
  return useMemo(
    () =>
      deriveAiVaultScopeSessionPaths(worktree, worktrees, {
        scope,
        activeProjectKey,
        projectHostSetupProjection
      }),
    [worktree, worktrees, scope, activeProjectKey, projectHostSetupProjection]
  )
}

export function useAiVaultPanelSearchWithin(
  scope: Parameters<typeof aiVaultSearchScopeIdentity>[0]['scope'],
  activeWorktreeId: string | undefined,
  activeProjectKey: string | null
) {
  return useMemo(
    () => aiVaultSearchScopeIdentity({ scope, activeWorktreeId, activeProjectKey }),
    [scope, activeWorktreeId, activeProjectKey]
  )
}
