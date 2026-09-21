import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export type RuntimeProjectRefreshSchedulerDeps = {
  refresh: (environmentId: string) => Promise<void>
  debounceMs?: number
  minIntervalMs?: number
  now?: () => number
  onError?: (error: unknown) => void
}

export type RuntimeProjectRefreshScheduler = {
  request: (environmentId: string) => void
  stop: () => void
}

type RefreshEntry = {
  inFlight: boolean
  lastStartedAt: number
  pending: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MIN_INTERVAL_MS = 5_000
const DEFAULT_REFRESH_CONCURRENCY = 5
/** Connect is one-shot and the user is waiting, so it cannot storm the way the coalesced event lane can. */
export const INTERACTIVE_CONNECT_REFRESH_CONCURRENCY = 15

export async function refreshRuntimeProjectWorktrees(
  environmentId: string,
  repos: readonly { id: string }[],
  fetchWorktrees: (
    repoId: string,
    options: {
      executionHostId: ExecutionHostId
      suppressRemoteLineageRefresh: true
    }
  ) => Promise<unknown>,
  concurrency = DEFAULT_REFRESH_CONCURRENCY
): Promise<void> {
  let nextIndex = 0
  const failures: { repoId: string; error: unknown }[] = []
  const repoIds = [...new Set(repos.map((repo) => repo.id))]
  const workerCount = Math.min(concurrency, repoIds.length)
  const executionHostId = toRuntimeExecutionHostId(environmentId)

  // Why: one coalesced event can represent many repos; bound probes without dropping host identity.
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < repoIds.length) {
        const index = nextIndex
        nextIndex += 1
        const repoId = repoIds[index]
        try {
          await fetchWorktrees(repoId, {
            executionHostId,
            suppressRemoteLineageRefresh: true
          })
        } catch (error) {
          failures.push({ repoId, error })
        }
      }
    })
  )
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `Failed to refresh ${failures.length} runtime project worktree(s): ${failures
        .map((failure) => failure.repoId)
        .join(', ')}`
    )
  }
}

/** Interactive connect: probes the catalog, then applies one host-wide lineage snapshot. */
export async function refreshRuntimeProjectWorktreesAndLineage(
  environmentId: string,
  repos: readonly { id: string }[],
  fetchWorktrees: Parameters<typeof refreshRuntimeProjectWorktrees>[2],
  fetchWorktreeLineage: (options: { executionHostId: ExecutionHostId }) => Promise<unknown>,
  concurrency = INTERACTIVE_CONNECT_REFRESH_CONCURRENCY
): Promise<void> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  let worktreeFailure: { error: unknown } | null = null
  try {
    await refreshRuntimeProjectWorktrees(environmentId, repos, fetchWorktrees, concurrency)
  } catch (error) {
    worktreeFailure = { error }
  }
  // Why: a failed repo refresh must not strand the host-wide lineage snapshot.
  try {
    await fetchWorktreeLineage({ executionHostId })
  } catch (lineageError) {
    if (!worktreeFailure) {
      throw lineageError
    }
    throw new AggregateError(
      [worktreeFailure.error, lineageError],
      'Failed to refresh runtime project worktrees and lineage'
    )
  }
  if (worktreeFailure) {
    throw worktreeFailure.error
  }
}

export function createRuntimeProjectRefreshScheduler(
  deps: RuntimeProjectRefreshSchedulerDeps
): RuntimeProjectRefreshScheduler {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const now = deps.now ?? Date.now
  const entries = new Map<string, RefreshEntry>()
  let stopped = false

  const getEntry = (environmentId: string): RefreshEntry => {
    let entry = entries.get(environmentId)
    if (!entry) {
      entry = {
        inFlight: false,
        lastStartedAt: 0,
        pending: false,
        timer: null
      }
      entries.set(environmentId, entry)
    }
    return entry
  }

  const schedule = (environmentId: string, entry: RefreshEntry): void => {
    if (stopped || entry.inFlight || entry.timer) {
      return
    }
    const elapsed = entry.lastStartedAt > 0 ? now() - entry.lastStartedAt : minIntervalMs
    const throttleDelay = Math.max(0, minIntervalMs - elapsed)
    const delay = Math.max(debounceMs, throttleDelay)
    entry.timer = setTimeout(() => {
      entry.timer = null
      void run(environmentId, entry)
    }, delay)
  }

  const run = async (environmentId: string, entry: RefreshEntry): Promise<void> => {
    if (stopped || !entry.pending) {
      return
    }
    entry.pending = false
    entry.inFlight = true
    entry.lastStartedAt = now()
    try {
      await deps.refresh(environmentId)
    } catch (error) {
      deps.onError?.(error)
    } finally {
      entry.inFlight = false
      if (entry.pending) {
        // Why: runtime repo events can be noisy while a remote server is merely
        // connected; keep discovery live without letting it drive the renderer.
        schedule(environmentId, entry)
      }
    }
  }

  const request = (environmentId: string): void => {
    const trimmedEnvironmentId = environmentId.trim()
    if (!trimmedEnvironmentId || stopped) {
      return
    }
    const entry = getEntry(trimmedEnvironmentId)
    entry.pending = true
    schedule(trimmedEnvironmentId, entry)
  }

  const stop = (): void => {
    stopped = true
    for (const entry of entries.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer)
      }
    }
    entries.clear()
  }

  return { request, stop }
}
