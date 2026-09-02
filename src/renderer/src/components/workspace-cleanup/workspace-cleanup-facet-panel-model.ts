import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostedReviewProvider } from '../../../../shared/hosted-review'
import type { WorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'

export type WorkspaceCleanupFacetCounts = Record<
  keyof Omit<WorkspaceCleanupFilterState, 'query'>,
  number
>

/** Facet values discovered from the loaded fleet, not a hardcoded enum. */
export type WorkspaceCleanupFacetOptions = {
  workspaceStatuses: readonly { id: string; label: string }[]
  hostIds: readonly ExecutionHostId[]
  repos: readonly { id: string; label: string }[]
  reviewProviders: readonly HostedReviewProvider[]
}

export type WorkspaceCleanupFacetGroupProps = {
  filters: WorkspaceCleanupFilterState
  counts: WorkspaceCleanupFacetCounts
  totalCount: number
  options: WorkspaceCleanupFacetOptions
  onPatch: <K extends keyof WorkspaceCleanupFilterState>(
    key: K,
    value: Partial<WorkspaceCleanupFilterState[K]> | WorkspaceCleanupFilterState[K]
  ) => void
}

export const WORKSPACE_CLEANUP_MEGABYTE = 1024 * 1024

export function toMegabytes(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / WORKSPACE_CLEANUP_MEGABYTE)
}

export function fromMegabytes(megabytes: number | null): number | null {
  return megabytes === null ? null : Math.round(megabytes * WORKSPACE_CLEANUP_MEGABYTE)
}

export function parseWorkspaceCleanupFacetNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '') {
    return null
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}
