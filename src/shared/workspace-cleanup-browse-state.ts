import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT,
  type WorkspaceCleanupFilterState,
  type WorkspaceCleanupSortState
} from './workspace-cleanup-filter-model'
import {
  asRecord,
  normalizeWorkspaceCleanupFilterState,
  normalizeWorkspaceCleanupSortState
} from './workspace-cleanup-filter-state-codec'

/** Bump only for a shape change the tolerant normalizer cannot absorb. */
export const WORKSPACE_CLEANUP_BROWSE_STATE_VERSION = 1

/** Plain JSON under WorkspaceCleanupUIState.browse must round-trip through disk and client-ui RPC. */
export type WorkspaceCleanupBrowseState = {
  version: number
  filters: WorkspaceCleanupFilterState
  sort: WorkspaceCleanupSortState
}

export function createDefaultWorkspaceCleanupBrowseState(): WorkspaceCleanupBrowseState {
  return {
    version: WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
    filters: createDefaultWorkspaceCleanupFilterState(),
    sort: { ...DEFAULT_WORKSPACE_CLEANUP_SORT }
  }
}

/** Normalize corrupt/older values field by field to defaults so one bad setting cannot brick the dialog. */
export function normalizeWorkspaceCleanupBrowseState(value: unknown): WorkspaceCleanupBrowseState {
  if (value == null) {
    return createDefaultWorkspaceCleanupBrowseState()
  }
  const raw = asRecord(value)
  return {
    version: WORKSPACE_CLEANUP_BROWSE_STATE_VERSION,
    filters: normalizeWorkspaceCleanupFilterState(raw.filters),
    sort: normalizeWorkspaceCleanupSortState(raw.sort)
  }
}
