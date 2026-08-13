import {
  isRuntimePathAbsolute,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { ProjectHostSetup, Worktree } from '../../../../shared/types'
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
  const claimedComparisonPaths =
    priorWorktreeIds.length > 0 ? buildClaimedComparisonPaths(liveWorktrees, activeWorktree) : null

  for (const priorWorktreeId of priorWorktreeIds) {
    const parsed = splitWorktreeIdForFilesystem(priorWorktreeId)
    if (!parsed || parsed.repoId !== activeWorktree.repoId) {
      continue
    }
    if (isAiVaultWorkspaceScopePathClaimed(parsed.worktreePath, claimedComparisonPaths)) {
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
): Map<string, ProjectHostSetup[]> {
  const setupsByRepoId = new Map<string, ProjectHostSetup[]>()
  for (const setup of projection?.setups ?? []) {
    const setups: ProjectHostSetup[] = setupsByRepoId.get(setup.repoId) ?? []
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

/**
 * Comparison paths owned by a worktree *other than* the active one.
 *
 * Why exclude the active worktree while building rather than when reading: a
 * path→id map would otherwise have to pick one owner among duplicates, and
 * picking the active worktree would mask a real claimant sitting later in the
 * list. Excluding it up front means any surviving entry is a claim by
 * definition, which matches the previous `some()` regardless of ordering.
 */
function buildClaimedComparisonPaths(
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path'>[],
  activeWorktree: Pick<Worktree, 'id'>
): Set<string> {
  const claimedPaths = new Set<string>()
  for (const worktree of liveWorktrees) {
    if (worktree.id === activeWorktree.id) {
      continue
    }
    const trimmedPath = worktree.path.trim()
    if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath)) {
      continue
    }
    claimedPaths.add(normalizeRuntimePathForComparison(trimmedPath))
  }
  return claimedPaths
}

function isAiVaultWorkspaceScopePathClaimed(
  pathValue: string,
  claimedComparisonPaths: Set<string> | null
): boolean {
  const trimmedPath = pathValue.trim()
  if (!trimmedPath || !isRuntimePathAbsolute(trimmedPath) || !claimedComparisonPaths) {
    return false
  }
  // AI Vault sessions are keyed by cwd only, so any live worktree now owning this path wins.
  return claimedComparisonPaths.has(normalizeRuntimePathForComparison(trimmedPath))
}
