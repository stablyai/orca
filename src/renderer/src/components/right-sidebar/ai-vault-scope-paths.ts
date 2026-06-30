import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { Worktree } from '../../../../shared/types'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree-id'

export function deriveAiVaultWorkspaceScopePaths(
  activeWorktree: Pick<Worktree, 'id' | 'path' | 'priorWorktreeIds' | 'repoId'> | null,
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path' | 'repoId'>[] = []
): string[] {
  if (!activeWorktree) {
    return []
  }

  const paths: string[] = []
  addAiVaultWorkspaceScopePath(paths, activeWorktree.path)

  for (const priorWorktreeId of activeWorktree.priorWorktreeIds ?? []) {
    const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
    if (!parsed || parsed.repoId !== activeWorktree.repoId) {
      continue
    }
    if (isAiVaultWorkspaceScopePathClaimed(parsed.worktreePath, activeWorktree, liveWorktrees)) {
      continue
    }
    addAiVaultWorkspaceScopePath(paths, parsed.worktreePath)
  }

  return paths
}

/**
 * Paths sent to the scanner so a scoped panel view surfaces its own sessions
 * even when they are older than the global recency cap. Covers the active
 * workspace plus the active project's other worktrees (same repo), so both the
 * Workspace and Project scopes stay complete.
 */
export function deriveAiVaultScopeSessionPaths(
  activeWorktree: Pick<
    Worktree,
    'id' | 'path' | 'priorWorktreeIds' | 'projectId' | 'repoId'
  > | null,
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path' | 'projectId' | 'repoId'>[] = [],
  options: {
    activeProjectKey?: string | null
    projectHostSetupProjection?: ProjectHostSetupProjection
  } = {}
): string[] {
  const paths = deriveAiVaultWorkspaceScopePaths(activeWorktree, liveWorktrees)
  if (!activeWorktree) {
    return paths
  }
  const setupsByRepoId = buildProjectSetupsByRepoId(options.projectHostSetupProjection)
  for (const worktree of liveWorktrees) {
    if (
      worktree.repoId === activeWorktree.repoId ||
      worktreeProjectKey(worktree) === options.activeProjectKey ||
      (setupsByRepoId.get(worktree.repoId) ?? []).some(
        (setup) => worktreeProjectKey(setup, setup) === options.activeProjectKey
      )
    ) {
      addAiVaultWorkspaceScopePath(paths, worktree.path)
    }
  }
  for (const setup of options.projectHostSetupProjection?.setups ?? []) {
    if (worktreeProjectKey(setup, setup) === options.activeProjectKey) {
      addAiVaultWorkspaceScopePath(paths, setup.path)
    }
  }
  return paths
}

function buildProjectSetupsByRepoId(
  projection?: ProjectHostSetupProjection
): Map<string, ProjectHostSetupProjection['setups']> {
  const setupsByRepoId = new Map<string, ProjectHostSetupProjection['setups']>()
  for (const setup of projection?.setups ?? []) {
    const setups = setupsByRepoId.get(setup.repoId) ?? []
    setups.push(setup)
    setupsByRepoId.set(setup.repoId, setups)
  }
  return setupsByRepoId
}

function worktreeProjectKey(
  entry: Pick<Worktree, 'projectId' | 'repoId'> | { projectId?: string | null; repoId?: string },
  setup?: { projectId?: string | null; repoId?: string }
): string | null {
  const projectId = entry.projectId ?? setup?.projectId ?? null
  if (projectId) {
    return projectId.startsWith('repo:') ? projectId : `project:${projectId}`
  }
  return entry.repoId ? `repo:${entry.repoId}` : null
}

function addAiVaultWorkspaceScopePath(paths: string[], pathValue: string): void {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  if (
    paths.some((existingPath) => normalizeRuntimePathForComparison(existingPath) === comparisonPath)
  ) {
    return
  }
  paths.push(trimmedPath)
}

function isAiVaultWorkspaceScopePathClaimed(
  pathValue: string,
  activeWorktree: Pick<Worktree, 'id'>,
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path'>[]
): boolean {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return false
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  // AI Vault sessions are keyed by cwd only, so any live worktree now owning this path wins.
  return liveWorktrees.some(
    (worktree) =>
      worktree.id !== activeWorktree.id &&
      normalizeRuntimePathForComparison(worktree.path) === comparisonPath
  )
}
