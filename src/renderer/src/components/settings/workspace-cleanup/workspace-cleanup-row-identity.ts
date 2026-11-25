import type { WorkspaceCleanupPreviewRow } from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { cleanupChangeRowKey } from './workspace-cleanup-row-key'

export type CleanupRowIdentity = {
  /** The row belongs to another project than the one whose rule is changing, or scope is global. */
  showProject: boolean
  /** Branch, else path, when the visible name alone would match another row. */
  detail?: string
}

/**
 * What each row must show so no two rows look or read the same: a project's own rows drop the
 * project name, a sibling project's rows keep it, a repeated name gains its branch or path, and a
 * project label two repositories share gains the checkout path.
 */
export function cleanupRowIdentities(
  rows: readonly WorkspaceCleanupPreviewRow[],
  scope?: { repoId?: string; name?: string }
): Map<string, CleanupRowIdentity> {
  const showProject = (row: WorkspaceCleanupPreviewRow) =>
    scope?.repoId === undefined || row.repoId !== scope.repoId
  const label = (row: WorkspaceCleanupPreviewRow) =>
    showProject(row) ? row.repoName : (scope?.name ?? row.repoName)
  const repoIdsByLabel = new Map<string, Set<string>>()
  if (scope?.repoId !== undefined && scope.name !== undefined) {
    repoIdsByLabel.set(scope.name, new Set([scope.repoId]))
  }
  const names = new Map<string, number>()
  const branches = new Map<string, number>()
  const visibleName = (row: WorkspaceCleanupPreviewRow) =>
    `${showProject(row) ? row.repoName : ''}\u0000${row.displayName}`
  for (const row of rows) {
    const owners = repoIdsByLabel.get(label(row)) ?? new Set<string>()
    repoIdsByLabel.set(label(row), owners.add(row.repoId))
    const name = visibleName(row)
    names.set(name, (names.get(name) ?? 0) + 1)
    branches.set(
      `${name}\u0000${row.branch}`,
      (branches.get(`${name}\u0000${row.branch}`) ?? 0) + 1
    )
  }
  const identities = new Map<string, CleanupRowIdentity>()
  for (const row of rows) {
    const shown = showProject(row)
    // The same project label on two repositories: only the checkout path tells them apart.
    const sharedLabel = shown && (repoIdsByLabel.get(label(row))?.size ?? 0) > 1
    const name = visibleName(row)
    const repeated = (names.get(name) ?? 0) > 1
    const branchUnique = row.branch && branches.get(`${name}\u0000${row.branch}`) === 1
    identities.set(cleanupChangeRowKey(row), {
      showProject: shown,
      detail: sharedLabel ? row.path : repeated ? (branchUnique ? row.branch : row.path) : undefined
    })
  }
  return identities
}

/** The row's spoken name: everything the row shows to tell it apart. */
export function cleanupRowAccessibleName(
  row: WorkspaceCleanupPreviewRow,
  identity: CleanupRowIdentity | undefined
): string {
  return [row.displayName, identity?.showProject ? row.repoName : null, identity?.detail]
    .filter(Boolean)
    .join(', ')
}
