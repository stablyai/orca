import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type {
  GitStatusEntry,
  GitStatusResult
} from '../../../../../../shared/git/status/git-status-types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'

type GitStatusRefreshScope = {
  target: RuntimeClientTarget
  ownerHostId: ExecutionHostId | null
  worktreeId: string
  worktreePath: string
  connectionId?: string
}

export function getGitStatusRefreshScopeKey(scope: GitStatusRefreshScope): string {
  return JSON.stringify([
    scope.target.kind === 'environment' ? scope.target.environmentId : null,
    scope.ownerHostId,
    scope.connectionId ?? null,
    scope.worktreeId,
    scope.worktreePath
  ])
}

const listeners = new Map<string, Set<(entries: readonly GitStatusEntry[]) => void>>()

export function subscribeToSuccessfulGitStatusRefresh(
  scopeKey: string,
  listener: (entries: readonly GitStatusEntry[]) => void
): () => void {
  const scopedListeners =
    listeners.get(scopeKey) ?? new Set<(entries: readonly GitStatusEntry[]) => void>()
  listeners.set(scopeKey, scopedListeners)
  scopedListeners.add(listener)
  return () => {
    scopedListeners.delete(listener)
    if (scopedListeners.size === 0) {
      listeners.delete(scopeKey)
    }
  }
}

export function publishSuccessfulGitStatusRefresh(
  scope: GitStatusRefreshScope,
  status: GitStatusResult
): void {
  if (status.readError === undefined) {
    listeners
      .get(getGitStatusRefreshScopeKey(scope))
      ?.forEach((listener) => listener(status.entries))
  }
}
