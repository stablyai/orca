import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-status-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getWorktreeGitOwnerTarget } from './worktree-git-owner-target'

const EMPTY_IGNORED_PATHS: readonly string[] = []
export const FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS = 300

export type IgnoredPathResult = {
  activeWorktreeId: string
  paths: string[]
  worktreePath: string
}

export function getEffectiveFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  ignoredPathResult,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  ignoredPathResult: IgnoredPathResult | null
  worktreePath: string | null
}): readonly string[] {
  const ignoredPathResultMatchesCurrentWorktree =
    ignoredPathResult !== null &&
    ignoredPathResult.activeWorktreeId === activeWorktreeId &&
    ignoredPathResult.worktreePath === worktreePath

  if (!canLoadIgnoredPaths || !ignoredPathResultMatchesCurrentWorktree) {
    return EMPTY_IGNORED_PATHS
  }

  // Retain same-worktree answers while expanded-folder queries refresh to prevent ignored-row flashes.
  return ignoredPathResult.paths
}

type IgnoredPathsQueryContext = {
  activeWorktreeId: string
  connectionId: string | undefined
  target: RuntimeClientTarget
  worktreePath: string
}

// Why: an in-flight query already left for a specific host; a changed owner
// target or connection must re-query instead of riding along its verdicts.
type IgnoredPathsQueryContextIdentity = {
  connectionId: string | undefined
  targetKey: string
}

type IgnoredPathsQueryWaiter = {
  context: IgnoredPathsQueryContext
  onSettled: (paths: string[]) => void
  paths: readonly string[]
}

type IgnoredPathsQueryFlight = {
  contextIdentity: IgnoredPathsQueryContextIdentity
  pathSet: Set<string>
  waiters: Set<IgnoredPathsQueryWaiter>
}

type IgnoredPathsQueryLane = {
  inFlight: IgnoredPathsQueryFlight | null
  pendingWaiters: Set<IgnoredPathsQueryWaiter>
}

const ignoredPathsQueryLanes = new Map<string, IgnoredPathsQueryLane>()

function ignoredPathsQueryTargetKey(target: RuntimeClientTarget): string {
  return target.kind === 'environment' ? `env:${target.environmentId}` : 'local'
}

function ignoredPathsQueryContextIdentity(
  context: IgnoredPathsQueryContext
): IgnoredPathsQueryContextIdentity {
  return {
    connectionId: context.connectionId,
    targetKey: ignoredPathsQueryTargetKey(context.target)
  }
}

function isSameIgnoredPathsQueryContextIdentity(
  left: IgnoredPathsQueryContextIdentity,
  right: IgnoredPathsQueryContextIdentity
): boolean {
  return left.connectionId === right.connectionId && left.targetKey === right.targetKey
}

function pumpIgnoredPathsQueryLane(key: string, lane: IgnoredPathsQueryLane): void {
  if (lane.inFlight !== null || lane.pendingWaiters.size === 0) {
    return
  }
  // Why: pending waiters may carry different owner targets or connections, and a
  // later caller joining the in-flight flight must not re-anchor them. Seed each
  // trailing flight from the first pending waiter and merge only waiters sharing
  // its context identity; the rest stay pending for the next pump round.
  let seed: IgnoredPathsQueryWaiter | null = null
  const merged: IgnoredPathsQueryWaiter[] = []
  for (const waiter of lane.pendingWaiters) {
    if (seed === null) {
      seed = waiter
    } else if (
      !isSameIgnoredPathsQueryContextIdentity(
        ignoredPathsQueryContextIdentity(seed.context),
        ignoredPathsQueryContextIdentity(waiter.context)
      )
    ) {
      continue
    }
    merged.push(waiter)
  }
  if (seed === null) {
    return
  }
  const seedContext = seed.context
  const pathSet = new Set<string>()
  for (const waiter of merged) {
    for (const path of waiter.paths) {
      pathSet.add(path)
    }
  }
  const flight: IgnoredPathsQueryFlight = {
    contextIdentity: ignoredPathsQueryContextIdentity(seedContext),
    pathSet,
    waiters: new Set(merged)
  }
  for (const waiter of merged) {
    lane.pendingWaiters.delete(waiter)
  }
  lane.inFlight = flight
  getRuntimeGitIgnoredPaths(
    {
      target: seedContext.target,
      worktreeId: seedContext.activeWorktreeId,
      worktreePath: seedContext.worktreePath,
      connectionId: seedContext.connectionId
    },
    [...flight.pathSet]
  )
    .then((paths) => {
      settleIgnoredPathsQueryLane(key, lane, flight, paths)
    })
    .catch(() => {
      settleIgnoredPathsQueryLane(key, lane, flight, [])
    })
}

function settleIgnoredPathsQueryLane(
  key: string,
  lane: IgnoredPathsQueryLane,
  flight: IgnoredPathsQueryFlight,
  paths: string[]
): void {
  lane.inFlight = null
  for (const waiter of flight.waiters) {
    // Why: the flight's verdicts cover every merged caller's paths; each caller
    // must only see the verdicts for the paths it actually requested.
    const requested = new Set(waiter.paths)
    waiter.onSettled(paths.filter((path) => requested.has(path)))
  }
  if (lane.pendingWaiters.size === 0) {
    ignoredPathsQueryLanes.delete(key)
    return
  }
  pumpIgnoredPathsQueryLane(key, lane)
}

export function requestFileExplorerIgnoredPaths(
  context: IgnoredPathsQueryContext,
  paths: readonly string[],
  onSettled: (paths: string[]) => void
): () => void {
  const key = `${context.activeWorktreeId}\u0000${context.worktreePath}`
  const existingLane = ignoredPathsQueryLanes.get(key)
  const lane: IgnoredPathsQueryLane = existingLane ?? {
    inFlight: null,
    pendingWaiters: new Set()
  }
  if (existingLane === undefined) {
    ignoredPathsQueryLanes.set(key, lane)
  }

  const waiter: IgnoredPathsQueryWaiter = { context, onSettled, paths }
  const inFlight = lane.inFlight
  if (
    inFlight !== null &&
    isSameIgnoredPathsQueryContextIdentity(
      inFlight.contextIdentity,
      ignoredPathsQueryContextIdentity(context)
    ) &&
    paths.every((path) => inFlight.pathSet.has(path))
  ) {
    inFlight.waiters.add(waiter)
  } else {
    lane.pendingWaiters.add(waiter)
    pumpIgnoredPathsQueryLane(key, lane)
  }

  // Why: watcher-driven relativePaths changes used to relaunch a full uncancellable
  // check-ignore query per change; coalesce them into one in-flight query plus one
  // trailing merge per worktree, and drop a caller's paths on unmount whether it was
  // still pending or already riding the in-flight query.
  return () => {
    lane.pendingWaiters.delete(waiter)
    lane.inFlight?.waiters.delete(waiter)
  }
}

export function useFileExplorerIgnoredPaths({
  activeWorktreeId,
  canLoadIgnoredPaths,
  relativePaths,
  shouldDebounceIgnoredQuery,
  worktreePath
}: {
  activeWorktreeId: string | null
  canLoadIgnoredPaths: boolean
  relativePaths: readonly string[]
  shouldDebounceIgnoredQuery: boolean
  worktreePath: string | null
}): readonly string[] {
  const [ignoredPathResult, setIgnoredPathResult] = useState<IgnoredPathResult | null>(null)

  useEffect(() => {
    if (!canLoadIgnoredPaths || !activeWorktreeId || !worktreePath) {
      return
    }

    let canceled = false
    let cancelRequest: (() => void) | null = null
    const applyResult = (paths: string[]): void => {
      if (!canceled) {
        setIgnoredPathResult({ activeWorktreeId, paths, worktreePath })
      }
    }
    const request = (): void => {
      const target = getWorktreeGitOwnerTarget(activeWorktreeId)
      if (!target) {
        return
      }
      cancelRequest = requestFileExplorerIgnoredPaths(
        {
          activeWorktreeId,
          connectionId: getConnectionId(activeWorktreeId) ?? undefined,
          target,
          worktreePath
        },
        [...relativePaths],
        applyResult
      )
    }

    // Debounce filter changes before launching uncancellable Git query chains; visible name filtering stays immediate.
    const timer = shouldDebounceIgnoredQuery
      ? window.setTimeout(request, FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS)
      : null
    if (timer === null) {
      request()
    }

    return () => {
      canceled = true
      cancelRequest?.()
      if (timer !== null) {
        window.clearTimeout(timer)
      }
    }
  }, [
    activeWorktreeId,
    canLoadIgnoredPaths,
    relativePaths,
    shouldDebounceIgnoredQuery,
    worktreePath
  ])

  return getEffectiveFileExplorerIgnoredPaths({
    activeWorktreeId,
    canLoadIgnoredPaths,
    ignoredPathResult,
    worktreePath
  })
}
