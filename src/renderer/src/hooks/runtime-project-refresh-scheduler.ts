import { toRuntimeExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'

export type RuntimeProjectRefreshSchedulerDeps = {
  refresh: (environmentId: string) => Promise<void>
  debounceMs?: number
  minIntervalMs?: number
  maxConcurrentRefreshes?: number
  isEnvironmentDesired?: (environmentId: string) => boolean
  getPrioritizedEnvironmentId?: () => string | null
  now?: () => number
  onError?: (error: unknown) => void
}

export type RuntimeProjectRefreshScheduler = {
  request: (environmentId: string) => void
  reprioritize: () => void
  stop: () => void
}

type RefreshEntry = {
  inFlight: boolean
  lastStartedAt: number
  pending: boolean
  queued: boolean
  timer: ReturnType<typeof setTimeout> | null
}

type ReadyRefresh = {
  environmentId: string
  entry: RefreshEntry
}

const DEFAULT_DEBOUNCE_MS = 250
const DEFAULT_MIN_INTERVAL_MS = 5_000
// Why 3, not 2: one slot is reserved for the foreground workspace and is not lent out,
// so a cap of 2 left exactly one background lane and serialized host discovery. Three
// keeps the reservation intact while giving background hosts the two lanes we intend.
const DEFAULT_ENVIRONMENT_REFRESH_CONCURRENCY = 3
const DEFAULT_WORKTREE_REFRESH_CONCURRENCY = 5

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
  concurrency = DEFAULT_WORKTREE_REFRESH_CONCURRENCY
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

export async function refreshRuntimeProjectWorktreesAndLineage(
  environmentId: string,
  repos: readonly { id: string }[],
  fetchWorktrees: Parameters<typeof refreshRuntimeProjectWorktrees>[2],
  fetchWorktreeLineage: (options: { executionHostId: ExecutionHostId }) => Promise<unknown>
): Promise<void> {
  const executionHostId = toRuntimeExecutionHostId(environmentId)
  let worktreeFailure: { error: unknown } | null = null
  try {
    await refreshRuntimeProjectWorktrees(environmentId, repos, fetchWorktrees)
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
  const maxConcurrentRefreshes = Math.max(
    1,
    Math.floor(deps.maxConcurrentRefreshes ?? DEFAULT_ENVIRONMENT_REFRESH_CONCURRENCY)
  )
  const isEnvironmentDesired = deps.isEnvironmentDesired ?? (() => true)
  const maxConcurrentNonPriorityRefreshes =
    deps.getPrioritizedEnvironmentId && maxConcurrentRefreshes > 1
      ? maxConcurrentRefreshes - 1
      : maxConcurrentRefreshes
  const now = deps.now ?? Date.now
  const entries = new Map<string, RefreshEntry>()
  const readyQueue: ReadyRefresh[] = []
  const activeEnvironmentIds = new Set<string>()
  let stopped = false

  const getEntry = (environmentId: string): RefreshEntry => {
    let entry = entries.get(environmentId)
    if (!entry) {
      entry = {
        inFlight: false,
        lastStartedAt: 0,
        pending: false,
        queued: false,
        timer: null
      }
      entries.set(environmentId, entry)
    }
    return entry
  }

  function takeNextReadyRefresh(prioritizedEnvironmentId: string | null): ReadyRefresh | null {
    if (prioritizedEnvironmentId) {
      const prioritizedEntry = entries.get(prioritizedEnvironmentId)
      if (prioritizedEntry?.queued) {
        const prioritizedIndex = readyQueue.findIndex(
          (next) => next.environmentId === prioritizedEnvironmentId
        )
        if (prioritizedIndex !== -1) {
          const [next] = readyQueue.splice(prioritizedIndex, 1)
          next.entry.queued = false
          if (next.entry.pending && !next.entry.inFlight) {
            if (isEnvironmentDesired(next.environmentId)) {
              return next
            }
            next.entry.pending = false
            entries.delete(next.environmentId)
          }
        }
      }
    }
    let activeNonPriorityRefreshes = 0
    for (const environmentId of activeEnvironmentIds) {
      if (environmentId !== prioritizedEnvironmentId) {
        activeNonPriorityRefreshes += 1
      }
    }
    if (
      readyQueue.length === 0 ||
      activeNonPriorityRefreshes >= maxConcurrentNonPriorityRefreshes
    ) {
      return null
    }
    while (readyQueue.length > 0) {
      const next = readyQueue.shift()!
      next.entry.queued = false
      if (!next.entry.pending || next.entry.inFlight) {
        continue
      }
      if (!isEnvironmentDesired(next.environmentId)) {
        next.entry.pending = false
        entries.delete(next.environmentId)
        continue
      }
      return next
    }
    return null
  }

  function drainQueue(): void {
    if (stopped) {
      return
    }
    const prioritizedEnvironmentId = deps.getPrioritizedEnvironmentId?.() ?? null
    while (activeEnvironmentIds.size < maxConcurrentRefreshes && readyQueue.length > 0) {
      const next = takeNextReadyRefresh(prioritizedEnvironmentId)
      if (!next) {
        return
      }
      activeEnvironmentIds.add(next.environmentId)
      void run(next.environmentId, next.entry)
    }
  }

  function enqueue(environmentId: string, entry: RefreshEntry): void {
    if (stopped || entry.inFlight || entry.queued || !entry.pending) {
      return
    }
    entry.queued = true
    readyQueue.push({ environmentId, entry })
    drainQueue()
  }

  function schedule(environmentId: string, entry: RefreshEntry): void {
    if (stopped || entry.inFlight || entry.queued || entry.timer) {
      return
    }
    const elapsed = entry.lastStartedAt > 0 ? now() - entry.lastStartedAt : minIntervalMs
    const throttleDelay = Math.max(0, minIntervalMs - elapsed)
    const delay = Math.max(debounceMs, throttleDelay)
    entry.timer = setTimeout(() => {
      entry.timer = null
      enqueue(environmentId, entry)
    }, delay)
  }

  async function run(environmentId: string, entry: RefreshEntry): Promise<void> {
    entry.pending = false
    entry.inFlight = true
    entry.lastStartedAt = now()
    try {
      await deps.refresh(environmentId)
    } catch (error) {
      deps.onError?.(error)
    } finally {
      entry.inFlight = false
      activeEnvironmentIds.delete(environmentId)
      if (!stopped && entry.pending) {
        // Why: runtime repo events can be noisy while a remote server is merely
        // connected; keep discovery live without letting it drive the renderer.
        schedule(environmentId, entry)
      }
      drainQueue()
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
    readyQueue.length = 0
    entries.clear()
  }

  return { request, reprioritize: drainQueue, stop }
}
