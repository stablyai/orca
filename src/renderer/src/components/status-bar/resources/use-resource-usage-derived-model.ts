import { useMemo } from 'react'
import type { AppState } from '../../../store/types'
import type { MemorySnapshot } from '../../../../../shared/diagnostics/process-stats-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import { mergeSnapshotAndSessions } from './workspace-attribution/merge-snapshot-and-sessions'
import {
  resolveResourceFolderWorkspace,
  resolveResourceWorkspaceHost,
  stampedRuntimeHostId
} from './workspace-attribution/resource-workspace-host'
import type { RuntimeHostResourceSample } from './workspace-attribution/resource-usage-merge-types'
import type { PtyListedSession as DaemonSession } from '../../../../../shared/terminal/pty/lifecycle/pty-listed-session'

import {
  type ResourceSessionBindingInputs,
  countUnboundDaemonSessions
} from './workspace-attribution/resource-session-bindings'
import {
  getResourceManagerAriaLabel,
  getResourceManagerTooltipLines
} from './popover/resource-manager-terminal-copy'
import {
  getCommitPressureToneClass,
  getResourceMemoryMetricCopy
} from './popover/resource-memory-metric-copy'
import { formatMemory } from './popover/resource-usage-metrics'
import {
  readAgentPaneKeys,
  sharedAgentProcessUsage,
  splitSnapshotByOwner
} from './popover/resource-owner-split'
import {
  findAmbiguousWorktreeIds,
  findDuplicateIds
} from '../../../lib/workspace/ownership/unified-tab-host-ownership'
import { useTranslate } from '../../../i18n/use-translate'

export function useResourceUsageDerivedModel({
  open,
  resourceSnapshot,
  runtimeHostResources,
  sessions,
  resourceSessionBindings,
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
  const t = useTranslate()
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
        ? mergeSnapshotAndSessions(
            resourceSnapshot,
            sessions,
            {
              // Share all binding inputs with bulk selection so deferred SSH sessions also require single-row kill confirmation.
              ...resourceSessionBindings,
              repoDisplayNameById,
              repoConnectionIdById,
              repoRuntimeHostIdById,
              runtimeHostResources,
              browserTabsByWorktree,
              worktreeById,
              ambiguousWorktreeIds
            },
            t
          )
        : [],
    [
      open,
      resourceSnapshot,
      sessions,
      resourceSessionBindings,
      repoDisplayNameById,
      repoConnectionIdById,
      repoRuntimeHostIdById,
      runtimeHostResources,
      browserTabsByWorktree,
      worktreeById,
      ambiguousWorktreeIds,
      t
    ]
  )

  // Why: open-only and keyed to the 2 s snapshot and daemon inventory; agent status is read here
  // rather than subscribed because it churns many times a second.
  const ownerSplit = useMemo(
    () =>
      open && resourceSnapshot
        ? splitSnapshotByOwner(resourceSnapshot, sessions, readAgentPaneKeys())
        : null,
    [open, resourceSnapshot, sessions]
  )

  // Once per shown sample or host placement change; title and binding churn never rewalk it.
  const sharedAgentUsage = useMemo(() => {
    if (!open || !resourceSnapshot) {
      return null
    }
    const hostCtx = {
      worktreeById,
      ambiguousWorktreeIds,
      repoConnectionIdById,
      repoRuntimeHostIdById
    }
    // The merge leaves out local samples for workspaces a paired machine hosts; so does this sum.
    return sharedAgentProcessUsage(resourceSnapshot, (worktree) => {
      const repoId =
        resolveResourceFolderWorkspace(hostCtx, worktree.worktreeId)?.repoId ?? worktree.repoId
      return (
        !resolveResourceWorkspaceHost(hostCtx, worktree.worktreeId, repoId).runtimeHostId &&
        !stampedRuntimeHostId(hostCtx, worktree.worktreeId)
      )
    })
  }, [
    open,
    resourceSnapshot,
    worktreeById,
    ambiguousWorktreeIds,
    repoConnectionIdById,
    repoRuntimeHostIdById
  ])

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
    resourceSnapshot?.processMemoryMetric ?? 'rss',
    t
  )
  const { totalPrivateMemory, commitToneClass } = useMemo(() => {
    const privateMemory = resourceSnapshot?.totalPrivateMemory
    return {
      totalPrivateMemory: privateMemory,
      commitToneClass: getCommitPressureToneClass({
        privateMemory,
        hostTotalMemory: resourceSnapshot?.host.totalMemory ?? 0
      })
    }
  }, [resourceSnapshot])
  // Missing commit support on Unix/older hosts means unknown, not zero committed bytes.
  const commitBadgeLabel =
    resourceSnapshot?.processCommitMetric && totalPrivateMemory !== undefined
      ? formatMemory(totalPrivateMemory)
      : null

  // Why: memorySnapshotError null means "succeeded" OR "never fetched"; a sessions failure before any snapshot still counts as daemon-unreachable.
  const daemonUnreachable = sessionsError && (memorySnapshotError !== null || snapshot === null)
  // Why: sessions IPC can fail while snapshot IPC works; flag it so the empty session list isn't mistaken for healthy.
  const sessionsOnlyError = sessionsError && memorySnapshotError === null
  const resourceManagerTooltipLines = getResourceManagerTooltipLines(
    {
      sessionCount: triggerSessionCount,
      spaceScanReady
    },
    t
  )
  const resourceManagerAriaLabel = getResourceManagerAriaLabel(
    {
      sessionCount: triggerSessionCount,
      spaceScanReady
    },
    t
  )

  return {
    unifiedRepos,
    ownerSplit,
    sharedAgentUsage,
    orphanCount,
    triggerSessionCount,
    memoryMetricCopy,
    commitToneClass,
    commitBadgeLabel,
    daemonUnreachable,
    sessionsOnlyError,
    resourceManagerTooltipLines,
    resourceManagerAriaLabel
  }
}
