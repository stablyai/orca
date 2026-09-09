import { useMemo } from 'react'
import type { AppState } from '../../store/types'
import type { MemorySnapshot } from '../../../../shared/process-stats-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { mergeSnapshotAndSessions } from './mergeSnapshotAndSessions'
import type { DaemonSession } from './resource-usage-merge-types'
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

export function useResourceUsageDerivedModel({
  open,
  resourceSnapshot,
  sessions,
  resourceSessionBindings,
  runtimePaneTitlesByTabId,
  repos,
  allWorktrees,
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
  sessions: readonly DaemonSession[]
  resourceSessionBindings: ResourceSessionBindingInputs
  runtimePaneTitlesByTabId: AppState['runtimePaneTitlesByTabId']
  repos: AppState['repos']
  allWorktrees: Worktree[]
  browserTabsByWorktree: AppState['browserTabsByWorktree']
  workspaceSessionReady: boolean
  sessionCount: number
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
    return map
  }, [repos])

  // Why: non-null connectionId is the only honest "remote" signal (SSH PTYs run remote); build from the store, not a missing memory sample.
  const repoConnectionIdById = useMemo(() => {
    const map = new Map<string, string | null>()
    for (const repo of repos) {
      map.set(repo.id, repo.connectionId ?? null)
    }
    return map
  }, [repos])

  // Why: runtime-hosted repos have no local daemon samples or killable sessions; this map drives their per-row exclusion in the merge.
  const repoRuntimeScopedById = useMemo(() => {
    const map = new Map<string, boolean>()
    for (const repo of repos) {
      const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
      map.set(repo.id, parsed?.kind === 'runtime')
    }
    return map
  }, [repos])

  const worktreeById = useMemo(
    () => new Map(allWorktrees.map((worktree) => [worktree.id, worktree])),
    [allWorktrees]
  )

  // Why: skip the merge when closed; the always-mounted segment recomputing on every keystroke-driven store mutation made the app laggy.
  const unifiedRepos = useMemo(
    () =>
      open
        ? mergeSnapshotAndSessions(resourceSnapshot, sessions, {
            // Why spread: the rows and the bulk selector must classify from the identical binding
            // inputs. Re-listing them here let the row path miss deferred SSH sessions, so their
            // single-row kill skipped confirmation while bulk cleanup correctly spared them (#8459).
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

  // Why: orphan detection needs daemon inventory; keep it open-only so the closed badge never triggers a background global session scan.
  const orphanCount = useMemo(() => {
    if (!open || !workspaceSessionReady) {
      return 0
    }
    return countUnboundDaemonSessions(sessions, resourceSessionBindings)
  }, [open, sessions, resourceSessionBindings, workspaceSessionReady])

  // Why: open and closed badges share the same daemon inventory cache. The old
  // closed path used boundPtyIds (wake hints) and inflated the chip to 60+.
  const triggerSessionCount = sessionCount

  const memoryMetricCopy = getResourceMemoryMetricCopy(
    resourceSnapshot?.processMemoryMetric ?? 'rss'
  )
  // Why null-not-zero: a host that cannot read commit (every Unix host, and any
  // host older than the field) must render nothing here, never "0 B committed".
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
