import { useEffect, useState } from 'react'
import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeGitIgnoredPaths } from '@/runtime/runtime-git-client'
import { getRightSidebarWorktreeRuntimeSettings } from './file-explorer-runtime-owner'

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

  // Why: expanding folders changes the query before the async ignored refresh returns.
  // Keep same-worktree answers so known ignored rows do not flash as normal text.
  return ignoredPathResult.paths
}

type IgnoredPathsQueryContext = {
  activeWorktreeId: string
  connectionId: string | undefined
  settings: ReturnType<typeof getRightSidebarWorktreeRuntimeSettings>
  worktreePath: string
}

// Why: an in-flight query already left for a specific host; a changed runtime
// environment or connection must re-query instead of riding along its verdicts.
type IgnoredPathsQueryContextIdentity = {
  connectionId: string | undefined
  runtimeEnvironmentId: ReturnType<
    typeof getRightSidebarWorktreeRuntimeSettings
  >['activeRuntimeEnvironmentId']
}

type IgnoredPathsQueryWaiter = {
  onSettled: (paths: string[]) => void
  paths: readonly string[]
}

type IgnoredPathsQueryFlight = {
  contextIdentity: IgnoredPathsQueryContextIdentity
  pathSet: Set<string>
  waiters: Set<IgnoredPathsQueryWaiter>
}

type IgnoredPathsQueryLane = {
  context: IgnoredPathsQueryContext
  inFlight: IgnoredPathsQueryFlight | null
  pendingWaiters: Set<IgnoredPathsQueryWaiter>
}

const ignoredPathsQueryLanes = new Map<string, IgnoredPathsQueryLane>()

function ignoredPathsQueryContextIdentity(
  context: IgnoredPathsQueryContext
): IgnoredPathsQueryContextIdentity {
  return {
    connectionId: context.connectionId,
    runtimeEnvironmentId: context.settings.activeRuntimeEnvironmentId
  }
}

function isSameIgnoredPathsQueryContextIdentity(
  left: IgnoredPathsQueryContextIdentity,
  right: IgnoredPathsQueryContextIdentity
): boolean {
  return (
    left.connectionId === right.connectionId &&
    left.runtimeEnvironmentId === right.runtimeEnvironmentId
  )
}

function pumpIgnoredPathsQueryLane(key: string, lane: IgnoredPathsQueryLane): void {
  if (lane.inFlight !== null || lane.pendingWaiters.size === 0) {
    return
  }
  const pathSet = new Set<string>()
  for (const waiter of lane.pendingWaiters) {
    for (const path of waiter.paths) {
      pathSet.add(path)
    }
  }
  const flight: IgnoredPathsQueryFlight = {
    contextIdentity: ignoredPathsQueryContextIdentity(lane.context),
    pathSet,
    waiters: lane.pendingWaiters
  }
  lane.pendingWaiters = new Set()
  lane.inFlight = flight
  getRuntimeGitIgnoredPaths(
    {
      settings: lane.context.settings,
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
    waiter.onSettled(paths)
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
    pendingWaiters: new Set()
  }
  if (existingLane === undefined) {
    ignoredPathsQueryLanes.set(key, lane)
  }
  lane.context = context

  const waiter: IgnoredPathsQueryWaiter = { onSettled, paths }
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
  // trailing merge per worktree, and drop a caller's pending paths on unmount.
  return () => {
    lane.pendingWaiters.delete(waiter)
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
      cancelRequest = requestFileExplorerIgnoredPaths(
        {
          activeWorktreeId,
          connectionId: getConnectionId(activeWorktreeId) ?? undefined,
          settings: getRightSidebarWorktreeRuntimeSettings(activeWorktreeId),
          worktreePath
        },
        [...relativePaths],
        applyResult
      )
    }

    // Why: every filter keystroke changes relativePaths. Waiting for a short
    // quiet window prevents obsolete queries from launching uncancellable Git
    // subprocess chains while the visible name projection stays immediate.
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
