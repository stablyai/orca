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

  return collectWorkspaceScopePaths(activeWorktree, liveWorktrees).paths
}

function collectWorkspaceScopePaths(
  activeWorktree: Pick<Worktree, 'id' | 'path' | 'priorWorktreeIds' | 'repoId'>,
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path' | 'repoId'>[]
): ScopePathAccumulator {
  const accumulator = createScopePathAccumulator()
  addAiVaultWorkspaceScopePath(accumulator, activeWorktree.path)

  const priorWorktreeIds = activeWorktree.priorWorktreeIds ?? []
  // Built once instead of rescanning every live worktree per prior id.
  const worktreeIdByPath =
    priorWorktreeIds.length > 0 ? buildWorktreeIdByComparisonPath(liveWorktrees) : null

  for (const priorWorktreeId of priorWorktreeIds) {
    const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
    if (!parsed || parsed.repoId !== activeWorktree.repoId) {
      continue
    }
    if (isAiVaultWorkspaceScopePathClaimed(parsed.worktreePath, activeWorktree, worktreeIdByPath)) {
      continue
    }
    addAiVaultWorkspaceScopePath(accumulator, parsed.worktreePath)
  }

  return accumulator
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
  if (!activeWorktree) {
    return []
  }
  // Carries the workspace pass's dedupe keys forward, so the project pass does
  // not restart deduplication against a plain array.
  const accumulator = collectWorkspaceScopePaths(activeWorktree, liveWorktrees)
  const setupsByRepoId = buildProjectSetupsByRepoId(options.projectHostSetupProjection)
  for (const worktree of liveWorktrees) {
    if (
      worktree.repoId === activeWorktree.repoId ||
      worktreeProjectKey(worktree) === options.activeProjectKey ||
      (setupsByRepoId.get(worktree.repoId) ?? []).some(
        (setup) => worktreeProjectKey(setup, setup) === options.activeProjectKey
      )
    ) {
      addAiVaultWorkspaceScopePath(accumulator, worktree.path)
    }
  }
  for (const setup of options.projectHostSetupProjection?.setups ?? []) {
    if (worktreeProjectKey(setup, setup) === options.activeProjectKey) {
      addAiVaultWorkspaceScopePath(accumulator, setup.path)
    }
  }
  return accumulator.paths
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

/**
 * Paths plus their comparison keys.
 *
 * Why the key set: deduping by rescanning the accumulated paths re-normalized
 * every accepted path on every insert, which is O(n^2) `normalize('NFC')` calls
 * and cost ~190ms on a 1124-workspace profile — on the workspace-switch path,
 * since these paths are derived from the active worktree.
 */
type ScopePathAccumulator = {
  paths: string[]
  comparisonKeys: Set<string>
}

function createScopePathAccumulator(): ScopePathAccumulator {
  return { paths: [], comparisonKeys: new Set() }
}

function addAiVaultWorkspaceScopePath(accumulator: ScopePathAccumulator, pathValue: string): void {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
    return
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  if (accumulator.comparisonKeys.has(comparisonPath)) {
    return
  }
  accumulator.comparisonKeys.add(comparisonPath)
  accumulator.paths.push(trimmedPath)
}

/** Comparison path → owning worktree id, so a claim check is one lookup. */
function buildWorktreeIdByComparisonPath(
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path'>[]
): Map<string, string> {
  const worktreeIdByPath = new Map<string, string>()
  for (const worktree of liveWorktrees) {
    const trimmedPath = worktree.path.trim()
    if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
      continue
    }
    // First writer wins, matching the previous `some()` short-circuit order.
    const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
    if (!worktreeIdByPath.has(comparisonPath)) {
      worktreeIdByPath.set(comparisonPath, worktree.id)
    }
  }
  return worktreeIdByPath
}

function isAiVaultWorkspaceScopePathClaimed(
  pathValue: string,
  activeWorktree: Pick<Worktree, 'id'>,
  worktreeIdByComparisonPath: Map<string, string> | null
): boolean {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath) || !worktreeIdByComparisonPath) {
    return false
  }
  const comparisonPath = normalizeRuntimePathForComparison(trimmedPath)
  // AI Vault sessions are keyed by cwd only, so any live worktree now owning this path wins.
  const owningWorktreeId = worktreeIdByComparisonPath.get(comparisonPath)
  return owningWorktreeId !== undefined && owningWorktreeId !== activeWorktree.id
}
