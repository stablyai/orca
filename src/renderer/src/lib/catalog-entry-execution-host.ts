import type { ExecutionHostId } from '../../../shared/execution-host'
import { getCatalogOwnerHostId } from './worktree-runtime-owner-index'

/** Normalizes an already-selected catalog row's (project group or repo) host
 *  fields into a routable ExecutionHostId, matching getCatalogOwnerHostId's
 *  SSH/local fallback. */
export function getCatalogEntryExecutionHostId(
  entry: { executionHostId?: string | null; connectionId?: string | null } | undefined
): ExecutionHostId | undefined {
  return entry ? getCatalogOwnerHostId(entry) : undefined
}
