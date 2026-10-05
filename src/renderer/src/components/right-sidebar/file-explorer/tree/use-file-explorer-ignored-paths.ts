import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-status-client'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getWorktreeGitOwnerTarget } from '../../source-control/sync/worktree-git-owner-target'

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

type IgnoredPathsQueryFlight = {
  pathSet: Set<string>
  waiters: Set<(paths: string[]) => void>
}

type IgnoredPathsQueryLane = {
  context: IgnoredPathsQueryContext
  inFlight: IgnoredPathsQueryFlight | null
  pendingPathSet: Set<string>
  pendingWaiters: Set<(paths: string[]) => void>
}

const ignoredPathsQueryLanes = new Map<string, IgnoredPathsQueryLane>()

function pumpIgnoredPathsQueryLane(key: string, lane: IgnoredPathsQueryLane): void {
  if (lane.inFlight !== null || lane.pendingWaiters.size === 0) {
    return
  }
  const flight: IgnoredPathsQueryFlight = {
    pathSet: lane.pendingPathSet,
    waiters: lane.pendingWaiters
  }
  lane.pendingPathSet = new Set()
  lane.pendingWaiters = new Set()
  lane.inFlight = flight
  getRuntimeGitIgnoredPaths(
    {
      target: lane.context.target,
      worktreeId: lane.context.activeWorktreeId,
      worktreePath: lane.context.worktreePath,
      connectionId: lane.context.connectionId
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
    waiter(paths)
  }
  if (lane.pendingWaiters.size === 0) {
    ignoredPathsQueryLanes.delete(key)
    return
  }
  pumpIgnoredPathsQueryLane(key, lane)
}

function requestFileExplorerIgnoredPaths(
  context: IgnoredPathsQueryContext,
  paths: readonly string[],
  onSettled: (paths: string[]) => void
): () => void {
  const key = `${context.activeWorktreeId}\u0000${context.worktreePath}`
  const existingLane = ignoredPathsQueryLanes.get(key)
  const lane: IgnoredPathsQueryLane = existingLane ?? {
    context,
    inFlight: null,
    pendingPathSet: new Set(),
    pendingWaiters: new Set()
  }
  if (existingLane === undefined) {
    ignoredPathsQueryLanes.set(key, lane)
  }
  lane.context = context

  if (lane.inFlight !== null && paths.every((path) => lane.inFlight?.pathSet.has(path) === true)) {
    lane.inFlight.waiters.add(onSettled)
  } else {
    for (const path of paths) {
      lane.pendingPathSet.add(path)
    }
    lane.pendingWaiters.add(onSettled)
    pumpIgnoredPathsQueryLane(key, lane)
  }

  // Why: watcher-driven relativePaths changes used to relaunch a full uncancellable
  // check-ignore query per change; coalesce them into one in-flight query plus one
  // trailing merge per worktree, and drop a caller's pending paths on unmount.
  return () => {
    lane.pendingWaiters.delete(onSettled)
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
