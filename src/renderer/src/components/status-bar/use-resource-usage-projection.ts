import { useEffect, useMemo, useState } from 'react'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { countEstimatedInactiveWorkspaces } from '../workspace-cleanup/inactive-workspace-estimate'
import { mergeSnapshotAndSessions } from './mergeSnapshotAndSessions'
import { countUnboundDaemonSessions } from './resource-session-bindings'
import {
  getResourceManagerAriaLabel,
  getResourceManagerTooltipLines
} from './resource-manager-terminal-copy'
import { getResourceMemoryMetricCopy } from './resource-memory-metric-copy'
import { formatMemory } from './ResourceUsageMetrics'
import type { ResourceUsageFoundation } from './use-resource-usage-foundation'

export function useResourceUsageProjection(foundation: ResourceUsageFoundation) {
  const {
    repos,
    allWorktrees,
    open,
    resourceSnapshot,
    sessions,
    resourceSessionBindings,
    runtimePaneTitlesByTabId,
    browserTabsByWorktree,
    workspaceSessionReady,
    sessionInventory,
    sessionsError,
    memorySnapshotError,
    snapshot,
    spaceScanReady
  } = foundation

  const repoDisplayNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const repo of repos) {
      const display = repo.displayName?.trim()
      if (display) {
        map.set(repo.id, display)
      }
    }
    return map
  }, [repos])

  // Why: connectionId is the only honest signal that a repo runs over SSH.
  const repoConnectionIdById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const repo of repos) {
      map.set(repo.id, repo.connectionId ?? null)
    }
    return map
  }, [repos])

  const repoRuntimeScopedById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const repo of repos) {
      const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
      map.set(repo.id, parsed?.kind === 'runtime')
    }
    return map
  }, [repos])

  const repoById = useMemo(() => new Map(repos.map((repo) => [repo.id, repo])), [repos])
  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )
  const [oldWorkspaceCount, setOldWorkspaceCount] = useState(0)
  useEffect(() => {
    setOldWorkspaceCount(countEstimatedInactiveWorkspaces(allWorktrees, repoById, Date.now()))
  }, [allWorktrees, repoById])

  // Why: the closed segment must not merge on keystroke-driven store updates.
  const unifiedRepos = useMemo(
    () =>
      open
        ? mergeSnapshotAndSessions(resourceSnapshot, sessions, {
            ...resourceSessionBindings,
            runtimePaneTitlesByTabId,
            repoDisplayNameById,
            repoConnectionIdById,
            repoRuntimeScopedById,
            browserTabsByWorktree,
            worktreeById
          })
        : [],
    [
      open,
      resourceSnapshot,
      sessions,
      resourceSessionBindings,
      runtimePaneTitlesByTabId,
      repoDisplayNameById,
      repoConnectionIdById,
      repoRuntimeScopedById,
      browserTabsByWorktree,
      worktreeById
    ]
  )

  const orphanCount = useMemo(() => {
    if (!open || !workspaceSessionReady) {
      return 0
    }
    return countUnboundDaemonSessions(sessions, resourceSessionBindings)
  }, [open, sessions, resourceSessionBindings, workspaceSessionReady])

  const triggerSessionCount = sessionInventory.count
  const memoryMetricCopy = getResourceMemoryMetricCopy(
    resourceSnapshot?.processMemoryMetric ?? 'rss'
  )
  const { totalMemory, totalCpu, memBadgeLabel } = useMemo(() => {
    const memory = resourceSnapshot?.totalMemory ?? 0
    const cpu = resourceSnapshot?.totalCpu ?? 0
    return {
      totalMemory: memory,
      totalCpu: cpu,
      memBadgeLabel: resourceSnapshot ? formatMemory(memory) : '—'
    }
  }, [resourceSnapshot])

  const daemonUnreachable = sessionsError && (memorySnapshotError !== null || snapshot === null)
  const sessionsOnlyError = sessionsError && memorySnapshotError === null
  const resourceManagerTooltipLines = getResourceManagerTooltipLines({
    memoryLabel: resourceSnapshot
      ? `${memBadgeLabel} · ${memoryMetricCopy.summaryLabel}`
      : memBadgeLabel,
    sessionCount: triggerSessionCount,
    spaceScanReady
  })
  const resourceManagerAriaLabel = getResourceManagerAriaLabel({
    sessionCount: triggerSessionCount,
    spaceScanReady
  })

  return {
    oldWorkspaceCount,
    unifiedRepos,
    orphanCount,
    triggerSessionCount,
    memoryMetricCopy,
    totalMemory,
    totalCpu,
    memBadgeLabel,
    daemonUnreachable,
    sessionsOnlyError,
    resourceManagerTooltipLines,
    resourceManagerAriaLabel
  }
}

export type ResourceUsageProjection = ReturnType<typeof useResourceUsageProjection>
