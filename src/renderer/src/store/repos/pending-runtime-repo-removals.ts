import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import {
  normalizePendingRuntimeRepoRemovals,
  type PendingRuntimeRepoRemoval
} from '../../../../shared/pending-runtime-repo-removal'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime/remote-runtime-client-error-classification'

let pending: readonly PendingRuntimeRepoRemoval[] = []
// One chain per server: a replayed repo.rm and a re-add of the same project must never overlap.
const environmentChains = new Map<string, Promise<unknown>>()

/** A transport failure, timeout or user disconnect proves nothing about the server's catalog, unlike a refusal. */
export function isRuntimeHostUnreachableError(error: unknown): boolean {
  return (
    !hasRuntimeRpcErrorCode(error, 'repo_not_found') &&
    (hasRuntimeRpcErrorCode(error, 'runtime_manually_disconnected') ||
      isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error)))
  )
}

export function seedPendingRuntimeRepoRemovals(value: unknown): void {
  pending = normalizePendingRuntimeRepoRemovals(value)
}

export function listPendingRuntimeRepoRemovals(
  environmentId: string
): readonly PendingRuntimeRepoRemoval[] {
  return pending.filter((entry) => entry.environmentId === environmentId)
}

function persist(): void {
  // Best effort: the in-memory record still fences this session when the profile cannot save.
  void Promise.resolve()
    .then(() => window.api.ui.set({ pendingRuntimeRepoRemovals: [...pending] }))
    .catch((error) => console.warn('[repos] failed to persist pending project removals', error))
}

export function recordPendingRuntimeRepoRemoval(environmentId: string, repoId: string): void {
  if (pending.some((entry) => entry.environmentId === environmentId && entry.repoId === repoId)) {
    return
  }
  pending = [...pending, { environmentId, repoId, requestedAt: Date.now() }]
  persist()
}

export function dropPendingRuntimeRepoRemovalsForEnvironment(environmentId: string): void {
  const next = pending.filter((entry) => entry.environmentId !== environmentId)
  if (next.length !== pending.length) {
    pending = next
    persist()
  }
}

export function clearPendingRuntimeRepoRemoval(environmentId: string, repoId: string): void {
  const next = pending.filter(
    (entry) => entry.environmentId !== environmentId || entry.repoId !== repoId
  )
  if (next.length !== pending.length) {
    pending = next
    persist()
  }
}

/** Catalog fence: a server that still lists a project this desktop removed must not bring it back. */
export function withoutPendingRuntimeRepoRemovals(
  repos: readonly Repo[],
  hostId: ExecutionHostId
): readonly Repo[] {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return repos
  }
  const removed = new Set(listPendingRuntimeRepoRemovals(host.environmentId).map((e) => e.repoId))
  if (removed.size === 0) {
    return repos
  }
  const kept = repos.filter((repo) => !removed.has(repo.id))
  return kept.length === repos.length ? repos : kept
}

/** Runs `operation` after every earlier replay or re-add for this server has settled. */
export function runExclusiveForRuntimeEnvironment<T>(
  environmentId: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = environmentChains.get(environmentId) ?? Promise.resolve()
  const run = previous.then(operation, operation)
  const settled = run.then(
    () => undefined,
    () => undefined
  )
  environmentChains.set(environmentId, settled)
  void settled.then(() => {
    if (environmentChains.get(environmentId) === settled) {
      environmentChains.delete(environmentId)
    }
  })
  return run
}

/** Replays owed removals on a now-reachable server; a re-add queued on the same chain wins if it came first. */
export function replayPendingRuntimeRepoRemovals(
  environmentId: string,
  removeOnHost: (repoId: string) => Promise<unknown>,
  onRefused: (repoId: string, error: unknown) => void
): Promise<'settled' | 'unreachable'> {
  if (listPendingRuntimeRepoRemovals(environmentId).length === 0) {
    return Promise.resolve('settled')
  }
  return runExclusiveForRuntimeEnvironment(environmentId, async () => {
    for (const { repoId } of listPendingRuntimeRepoRemovals(environmentId)) {
      // Re-read: a re-add that ran first on this chain cleared the record.
      if (!listPendingRuntimeRepoRemovals(environmentId).some((e) => e.repoId === repoId)) {
        continue
      }
      try {
        await removeOnHost(repoId)
      } catch (error) {
        if (isRuntimeHostUnreachableError(error)) {
          return 'unreachable'
        }
        if (!hasRuntimeRpcErrorCode(error, 'repo_not_found')) {
          // The server kept it: let its catalog show the project again rather than hide it forever.
          clearPendingRuntimeRepoRemoval(environmentId, repoId)
          onRefused(repoId, error)
          continue
        }
      }
      clearPendingRuntimeRepoRemoval(environmentId, repoId)
    }
    return 'settled'
  })
}

export function resetPendingRuntimeRepoRemovalsForTests(): void {
  pending = []
  environmentChains.clear()
}
