import type { OrcadLiveMigrationRendererPlan } from '../../../shared/orcad-live-migration-renderer-plan'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import type { AppState } from '../store/types'
import { getCatalogOwnerHostId } from '../lib/worktree-runtime-owner-index'
import { filterSetupsForPrunedRepoRows } from '../store/repos/repo-catalog-merge'

type CatalogState = Pick<
  AppState,
  'repos' | 'projectGroups' | 'folderWorkspaces' | 'worktreesByRepo' | 'detectedWorktreesByRepo'
>

/** Ordinary local refresh preserves SSH rows; only completed retirement authorizes removal. */
export function buildOrcadMigrationSourceRepoPatch(
  state: Pick<AppState, 'repos' | 'projectHostSetups'>,
  plan: OrcadLiveMigrationRendererPlan
): Pick<AppState, 'repos' | 'projectHostSetups'> {
  const source = toSshExecutionHostId(plan.sourceSshTargetId)
  const retired = new Set(plan.sourceCatalog.repoIds)
  const repos = state.repos.filter(
    (repo) => !retired.has(repo.id) || getCatalogOwnerHostId(repo) !== source
  )
  const retainedSetups = new Set(
    filterSetupsForPrunedRepoRows(state.projectHostSetups, state.repos, repos)
  )
  return {
    repos,
    projectHostSetups: state.projectHostSetups.filter(
      (setup) => setup.runtimeOwnerEnvironmentId || retainedSetups.has(setup)
    )
  }
}

export function assertOrcadMigrationSourceCatalogRetired(
  state: CatalogState,
  plan: OrcadLiveMigrationRendererPlan
): void {
  const source = toSshExecutionHostId(plan.sourceSshTargetId)
  for (const [rows, ids] of [
    [state.repos, plan.sourceCatalog.repoIds],
    [state.projectGroups, plan.sourceCatalog.projectGroupIds],
    [state.folderWorkspaces, plan.sourceCatalog.folderWorkspaceIds]
  ] as const) {
    const retired = new Set(ids)
    if (rows.some((row) => retired.has(row.id) && getCatalogOwnerHostId(row) === source)) {
      throw new Error('orcad_migration_renderer_source_catalog_not_refreshed')
    }
  }
}

/** Retire only captured source listings; never remove a colliding destination workspace. */
export function buildOrcadMigrationSourceListingPatch(
  state: CatalogState,
  plan: OrcadLiveMigrationRendererPlan
): Partial<CatalogState> {
  const source = toSshExecutionHostId(plan.sourceSshTargetId)
  const workspaces = new Set(plan.workspaces.map((workspace) => workspace.workspaceId))
  const keep = (row: CatalogState['worktreesByRepo'][string][number]) =>
    !workspaces.has(row.id) || row.hostId !== source || Boolean(row.runtimeOwnerEnvironmentId)
  const worktreesByRepo = { ...state.worktreesByRepo }
  const detectedWorktreesByRepo = { ...state.detectedWorktreesByRepo }
  let changedWorktrees = false
  let changedDetected = false
  for (const [key, rows] of Object.entries(state.worktreesByRepo)) {
    const kept = rows.filter(keep)
    if (kept.length !== rows.length) {
      worktreesByRepo[key] = kept
      changedWorktrees = true
    }
  }
  for (const [key, listing] of Object.entries(state.detectedWorktreesByRepo)) {
    const kept = listing.worktrees.filter(keep)
    if (kept.length !== listing.worktrees.length) {
      detectedWorktreesByRepo[key] = { ...listing, worktrees: kept }
      changedDetected = true
    }
  }
  return {
    ...(changedWorktrees ? { worktreesByRepo } : {}),
    ...(changedDetected ? { detectedWorktreesByRepo } : {})
  }
}
