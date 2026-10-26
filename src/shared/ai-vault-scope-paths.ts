import { isRuntimePathAbsolute, normalizeRuntimePathForComparison } from './cross-platform-path'
import type { ProjectHostSetupProjection } from './project-host-setup-projection'
import type { ProjectHostSetup } from './project-types'
import type { AiVaultScope } from './ai-vault-types'
import type { Worktree } from './worktree/types'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import { toAiVaultProjectKey } from './ai-vault-project-key'

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

/** Include workspace/project paths so scoped scans can find sessions older than the global recency cap. */
export function deriveAiVaultScopeSessionPaths(
  activeWorktree: Pick<
    Worktree,
    'id' | 'path' | 'priorWorktreeIds' | 'projectId' | 'repoId'
  > | null,
  liveWorktrees: readonly Pick<Worktree, 'id' | 'path' | 'projectId' | 'repoId'>[] = [],
  options: {
    scope?: AiVaultScope
    activeProjectKey?: string | null
    projectHostSetupProjection?: ProjectHostSetupProjection
  } = {}
): string[] {
  if (!activeWorktree) {
    return []
  }
  if (options.scope === 'workspace') {
    return deriveAiVaultWorkspaceScopePaths(activeWorktree, liveWorktrees)
  }
  // Carry workspace dedupe keys into the project pass instead of rescanning accepted paths.
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
  return toAiVaultProjectKey(entry.projectId ?? setup?.projectId ?? null, entry.repoId)
}

/** Retain comparison keys to avoid quadratic NFC normalization on workspace switches. */
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

/** Exclude the active worktree up front so duplicate paths cannot mask another owner, regardless of ordering. */
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
