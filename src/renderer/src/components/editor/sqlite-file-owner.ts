import { getConnectionIdForFile } from '@/lib/connection-context'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store'

// The reader is local-only, so an unknown owner must not fall back to reading a same-named local file.
export type SqliteFileOwner =
  | { kind: 'local' }
  | { kind: 'remote'; connectionId: string }
  | { kind: 'runtime-environment' }
  | { kind: 'unresolved' }

export function resolveSqliteFileOwner(
  worktreeId: string | null,
  filePath: string
): SqliteFileOwner {
  const settings = useAppStore.getState().settings
  if (getActiveRuntimeTarget(settings).kind === 'environment') {
    return { kind: 'runtime-environment' }
  }

  const connectionId = getConnectionIdForFile(worktreeId, filePath)
  if (connectionId === undefined) {
    return { kind: 'unresolved' }
  }
  return connectionId === null ? { kind: 'local' } : { kind: 'remote', connectionId }
}
