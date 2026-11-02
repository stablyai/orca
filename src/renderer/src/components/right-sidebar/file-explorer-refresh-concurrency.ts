import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { FileExplorerOperationOwner } from './file-explorer-types'

export const FILE_EXPLORER_LOCAL_REFRESH_CONCURRENCY = 16
export const FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY = 8
export const FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY = 4

/** Derive read cost from owner transport; runtime routes may say local even when reads require network RPC. */
export function fileExplorerRefreshConcurrency(owner: FileExplorerOperationOwner): number {
  switch (owner.kind) {
    case 'local':
      return FILE_EXPLORER_LOCAL_REFRESH_CONCURRENCY
    case 'ssh':
      return FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY
    case 'runtime':
      return parseExecutionHostId(owner.executionHostId)?.kind === 'ssh'
        ? FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY
        : FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY
    case 'unresolved':
      // Unknown ownership may use the slowest transport; stay conservative.
      return FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY
  }
}
