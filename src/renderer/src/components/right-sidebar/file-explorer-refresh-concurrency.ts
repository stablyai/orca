import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { FileExplorerOperationOwner } from './file-explorer-types'

export const FILE_EXPLORER_LOCAL_REFRESH_CONCURRENCY = 16
export const FILE_EXPLORER_RUNTIME_REFRESH_CONCURRENCY = 8
export const FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY = 4

/**
 * In-flight directory-read cap for one File Explorer refresh, by how expensive a
 * read is on the owning transport.
 *
 * Why: tiers come from the owner, not from `getFileExplorerOperationRoute`,
 * which maps every non-SSH runtime host to `expectedExecutionHostId: 'local'` —
 * including an `orca serve` runtime reached over a network socket, whose reads
 * are RPC round trips rather than disk reads.
 */
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
      // Why: unknown ownership could be the slowest transport; stay conservative.
      return FILE_EXPLORER_REMOTE_REFRESH_CONCURRENCY
  }
}
