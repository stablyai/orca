import { useMemo } from 'react'
import type { AppState } from '../../store/types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { mergeSnapshotAndSessions } from './mergeSnapshotAndSessions'
import type { DaemonSession, RuntimeHostResourceSample } from './resource-usage-merge-types'
import type { ResourceSessionBindingInputs } from './resource-session-bindings'
import { countUnboundDaemonSessions } from './resource-session-bindings'
import {
  getResourceManagerAriaLabel,
  getResourceManagerTooltipLines
} from './resource-manager-terminal-copy'
import {
  getCommitPressureToneClass,
  getResourceCommitMetricCopy,
  getResourceMemoryMetricCopy
} from './resource-memory-metric-copy'
import { formatMemory } from './resource-usage-metrics'
import { findAmbiguousWorktreeIds, findDuplicateIds } from '../../lib/unified-tab-host-ownership'

export function useResourceUsageDerivedModel({
  open,
  resourceSnapshot,
  runtimeHostResources,
  sessions,
  resourceSessionBindings,
  runtimePaneTitlesByTabId,
  repos,
  allWorktrees,
  projectGroups,
  browserTabsByWorktree,
  workspaceSessionReady,
  sessionCount,
  sessionsError,
  memorySnapshotError,
  snapshot,
  spaceScanReady
}: {
  open: boolean
  resourceSnapshot: MemorySnapshot | null
  runtimeHostResources: readonly RuntimeHostResourceSample[]
  sessions: readonly DaemonSession[]
  resourceSessionBindings: ResourceSessionBindingInputs
  runtimePaneTitlesByTabId: AppState['runtimePaneTitlesByTabId']
  repos: AppState['repos']
  allWorktrees: Worktree[]
  projectGroups: AppState['projectGroups']
  browserTabsByWorktree: AppState['browserTabsByWorktree']
  workspaceSessionReady: boolean
  sessionCount: number | null
  sessionsError: boolean
  memorySnapshotError: string | null
  snapshot: MemorySnapshot | null
  spaceScanReady: boolean
}) {
  const repoDisplayNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const repo of repos) {
      const display = repo.displayName?.trim()
      if (display) {
        map.set(repo.id, display)
      }
    }
    const ambiguousGroupIds = findDuplicateIds(projectGroups)
    for (const group of projectGroups) {
      if (!ambiguousGroupIds.has(group.id)) {
        map.set(`folder-workspace:${group.id}`, group.name)
      }
    }
    return map
  }, [repos, projectGroups])

  // Use execution-host metadata for SSH status; an absent sample cannot establish remoteness.
  const repoConnectionIdById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const repo of repos) {
      map.set(repo.id, repo.connectionId ?? null)
    }
    return map
  }, [repos])

  // Why: runtime-hosted repos have no local samples or killable sessions; their rows come only from that server's own samples.
  const repoRuntimeHostIdById = useMemo(() => {
    const map = new Map<string, string>()
    for (const repo of repos) {
      const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
      if (parsed?.kind === 'runtime') {
        map.set(repo.id, parsed.id)
      }
    }
    return map
  }, [repos])

  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )
  // Keep duplicate workspace IDs in the catalog; gate host attribution where the resource identity is ambiguous.
  const ambiguousWorktreeIds = useMemo(() => findAmbiguousWorktreeIds(allWorktrees), [allWorktrees])

  // Why: skip the merge when closed; the always-mounted segment recomputing on every keystroke-driven store mutation made the app laggy.
  const unifiedRepos = useMemo(
    () =>
      open
        ? mergeSnapshotAndSessions(resourceSnapshot, sessions, {
            // Share all binding inputs with bulk selection so deferred SSH sessions also require single-row kill confirmation.
            ...resourceSessionBindings,
            runtimePaneTitlesByTabId,
            repoDisplayNameById,
            repoConnectionIdById,
            repoRuntimeHostIdById,
            runtimeHostResources,
            browserTabsByWorktree,
            worktreeById,
            ambiguousWorktreeIds
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
      repoRuntimeHostIdById,
      runtimeHostResources,
      browserTabsByWorktree,
      worktreeById,
      ambiguousWorktreeIds
    ]
  )

  // Why: orphan detection needs daemon inventory; keep it open-only so the closed badge never triggers a background global session scan.
  const orphanCount = useMemo(() => {
    if (!open || !workspaceSessionReady) {
      return 0
    }
    return countUnboundDaemonSessions(sessions, resourceSessionBindings)
  }, [open, sessions, resourceSessionBindings, workspaceSessionReady])

  // Share daemon inventory for open and closed counts; wake hints are bindings, not a live session count.
  const triggerSessionCount = sessionCount

  const memoryMetricCopy = getResourceMemoryMetricCopy(
    resourceSnapshot?.processMemoryMetric ?? 'rss'
  )
  // Missing commit support on Unix/older hosts means unknown, not zero committed bytes.
  const commitMetricCopy = resourceSnapshot?.processCommitMetric
    ? getResourceCommitMetricCopy()
    : null
  const { totalMemory, totalCpu, memBadgeLabel, totalPrivateMemory, commitToneClass } =
    useMemo(() => {
      const memory = resourceSnapshot?.totalMemory ?? 0
      const cpu = resourceSnapshot?.totalCpu ?? 0
      const privateMemory = resourceSnapshot?.totalPrivateMemory
      return {
        totalMemory: memory,
        totalCpu: cpu,
        memBadgeLabel: resourceSnapshot ? formatMemory(memory) : '—',
        totalPrivateMemory: privateMemory,
        commitToneClass: getCommitPressureToneClass({
          privateMemory,
          hostTotalMemory: resourceSnapshot?.host.totalMemory ?? 0
        })
      }
    }, [resourceSnapshot])
  const commitBadgeLabel =
    commitMetricCopy && totalPrivateMemory !== undefined ? formatMemory(totalPrivateMemory) : null

  // Why: memorySnapshotError null means "succeeded" OR "never fetched"; a sessions failure before any snapshot still counts as daemon-unreachable.
  const daemonUnreachable = sessionsError && (memorySnapshotError !== null || snapshot === null)
  // Why: sessions IPC can fail while snapshot IPC works; flag it so the empty session list isn't mistaken for healthy.
  const sessionsOnlyError = sessionsError && memorySnapshotError === null
  const resourceManagerTooltipLines = getResourceManagerTooltipLines({
    memoryLabel: resourceSnapshot
      ? [
          `${memBadgeLabel} · ${memoryMetricCopy.summaryLabel}`,
          commitBadgeLabel && commitMetricCopy
            ? `${commitBadgeLabel} ${commitMetricCopy.summaryLabel}`
            : null
        ]
          .filter(Boolean)
          .join(' · ')
      : memBadgeLabel,
    sessionCount: triggerSessionCount,
    spaceScanReady
  })
  const resourceManagerAriaLabel = getResourceManagerAriaLabel({
    sessionCount: triggerSessionCount,
    spaceScanReady
  })

  return {
    unifiedRepos,
    orphanCount,
    triggerSessionCount,
    memoryMetricCopy,
    commitMetricCopy,
    totalMemory,
    totalCpu,
    memBadgeLabel,
    commitToneClass,
    commitBadgeLabel,
    daemonUnreachable,
    sessionsOnlyError,
    resourceManagerTooltipLines,
    resourceManagerAriaLabel
  }
}
