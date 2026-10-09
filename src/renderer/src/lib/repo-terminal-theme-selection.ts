import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { RepoTerminalThemeOverrides } from '../../../shared/repo-terminal-theme'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getApplicableRepoTerminalTheme } from './repo-terminal-theme-availability'
import { getResolvedExecutionHostIdForWorktree } from './resolved-worktree-execution-host'
import {
  findIndexedRepoOwnerForHost,
  resolveIndexedRepoOwner
} from './worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

type ThemeOwnerRepo = Pick<
  Repo,
  'id' | 'path' | 'connectionId' | 'executionHostId' | 'terminalTheme'
>

export type RepoTerminalThemeSelectionState = Omit<WorktreeRuntimeOwnerState, 'repos'> & {
  repos?: readonly ThemeOwnerRepo[]
}

function selectThemeOwnerRepo(
  state: RepoTerminalThemeSelectionState,
  worktreeId: string
): ThemeOwnerRepo | undefined {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const hostId = getResolvedExecutionHostIdForWorktree(state, worktreeId)
  if (hostId) {
    return findIndexedRepoOwnerForHost(state.repos, repoId, hostId) ?? undefined
  }
  const resolution = resolveIndexedRepoOwner(state.repos, repoId)
  if (resolution.kind !== 'resolved') {
    return undefined
  }
  return (
    findIndexedRepoOwnerForHost(state.repos, repoId, getRepoExecutionHostId(resolution.owner)) ??
    undefined
  )
}

/** Host-aware repo theme pick for a pane's worktree; identity-stable per stored value, so callers can compare by identity. */
export function selectRepoTerminalThemeForWorktree(
  state: RepoTerminalThemeSelectionState,
  worktreeId: string | null | undefined
): RepoTerminalThemeOverrides | undefined {
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return undefined
  }
  // Why: FolderWorkspaces are project-group scoped and have no Repo row to carry a theme.
  if (parseWorkspaceKey(worktreeId)?.type === 'folder') {
    return undefined
  }
  const owner = selectThemeOwnerRepo(state, worktreeId)
  return owner ? getApplicableRepoTerminalTheme(owner) : undefined
}
