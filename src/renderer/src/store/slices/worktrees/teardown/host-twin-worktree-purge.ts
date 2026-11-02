import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { WorktreePurgeTarget } from '../../worktree-purge-target'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspace-execution-host'
import { getProjectGroupHostId } from '../../project-group-owner-routing'
import {
  collectRemovedHostTwinState,
  removedHostCanonicalizer,
  twinSelectionPatch
} from '../../../repos/repo-removal-host-twin-attribution'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { buildActiveSurfacePatch } from '../../tabs/tabs-surface'
import { worktreeHostMatchOptions, worktreeMatchesHost } from '../listing/worktree-host-ownership'
import { collectSurfacePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { collectPtyIdsForTab } from '../../terminal-tab-retirement'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'

type PublisherRow = {
  id: string
  hostId?: ExecutionHostId
  runtimeOwnerEnvironmentId?: string
}

/**
 * For one targeted id: hosts outside the purge that still publish it, and the host each purged
 * target's state is attributed to. Rows match by the listing's host matching, so an unstamped
 * legacy row or a paired runtime's SSH row counts as the purged copy, not a twin.
 */
function resolvePurgedPublishers(
  s: AppState,
  workspaceId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
): { survivors: ExecutionHostId[]; attributedHostIds: Map<ExecutionHostId, ExecutionHostId> } {
  const scope = parseWorkspaceKey(workspaceId)
  const attributedHostIds = new Map([...purgedHosts].map((hostId) => [hostId, hostId]))
  if (scope?.type === 'folder') {
    const groups = s.projectGroups ?? []
    const hosts = (s.folderWorkspaces ?? [])
      .filter((folder) => folder.id === scope.folderWorkspaceId)
      .flatMap((folder) => {
        const groupHosts = groups
          .filter((group) => group.id === folder.projectGroupId)
          .map(getProjectGroupHostId)
        // Why every group host: an unstamped folder under a group two hosts publish may be either's.
        return folder.executionHostId || folder.connectionId || groupHosts.length === 0
          ? [getFolderWorkspaceHostId(folder, groups)]
          : groupHosts
      })
    return {
      survivors: [...new Set(hosts)].filter((hostId) => !purgedHosts.has(hostId)),
      attributedHostIds
    }
  }
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const rows: PublisherRow[] = [
    ...(s.worktreesByRepo[repoId] ?? []),
    ...(s.detectedWorktreesByRepo[repoId]?.worktrees ?? [])
  ].filter((row) => row.id === worktreeId)
  const survivors = new Set<ExecutionHostId>()
  for (const row of rows) {
    const purgedHost = [...purgedHosts].find((hostId) =>
      worktreeMatchesHost(row, hostId, worktreeHostMatchOptions(s, repoId, hostId))
    )
    if (purgedHost) {
      // Why: a copy reached through a paired runtime stamps its tabs with its own SSH host.
      if (row.hostId && !purgedHosts.has(row.hostId)) {
        attributedHostIds.set(purgedHost, row.hostId)
      }
      continue
    }
    survivors.add(
      row.hostId ??
        (row.runtimeOwnerEnvironmentId
          ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
          : LOCAL_EXECUTION_HOST_ID)
    )
  }
  return {
    survivors: [...survivors].filter((hostId) => !purgedHosts.has(hostId)),
    attributedHostIds
  }
}

/** Per attributed host, its twin ids with the hosts that still publish them. */
export type HostTwinPurgeScopes = Map<ExecutionHostId, Map<string, ExecutionHostId[]>>

/** Host targets whose id a host outside the purge still publishes. A raw id for the same id wins. */
export function collectHostTwinPurgeScopes(
  s: AppState,
  targets: readonly WorktreePurgeTarget[]
): HostTwinPurgeScopes {
  const rawIds = new Set(targets.filter((target) => !target.hostId).map((target) => target.id))
  const purgedHostsById = new Map<string, Set<ExecutionHostId>>()
  for (const { id, hostId } of targets) {
    if (hostId && !rawIds.has(id)) {
      purgedHostsById.set(id, (purgedHostsById.get(id) ?? new Set()).add(hostId))
    }
  }
  const scopes: HostTwinPurgeScopes = new Map()
  for (const [id, purgedHosts] of purgedHostsById) {
    const { survivors, attributedHostIds } = resolvePurgedPublishers(s, id, purgedHosts)
    if (survivors.length === 0) {
      continue
    }
    for (const hostId of purgedHosts) {
      const attributedHostId = attributedHostIds.get(hostId) ?? hostId
      const scope = scopes.get(attributedHostId) ?? new Map<string, ExecutionHostId[]>()
      scopes.set(attributedHostId, scope.set(id, survivors))
    }
  }
  return scopes
}

/**
 * Purges one host's attributable surfaces under ids a twin still publishes. Worktree-keyed
 * buckets, raw-id module stores and surfaces with no host evidence stay: they may be the twin's.
 */
export function buildHostTwinPurgeState(
  s: AppState,
  hostId: ExecutionHostId,
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>
): Partial<AppState> {
  const twinIds = new Set(twinHostIds.keys())
  const removed = collectRemovedHostTwinState(s, twinIds, hostId, twinHostIds)
  const canonical = (worktreeId: string) =>
    removedHostCanonicalizer(s, worktreeId, hostId, twinHostIds.get(worktreeId) ?? [])
  const cancelledSessionIds = cancelStructuredLaunchesForWorktrees(
    twinIds,
    (worktreeId, launchHostId) => canonical(worktreeId)(launchHostId) === hostId
  )
  const terminalTabs: { id: string; ptyId: string | null }[] = []
  for (const worktreeId of twinIds) {
    const legacyTabs = (s.tabsByWorktree[worktreeId] ?? []).filter((tab) =>
      removed.terminalTabIds.has(tab.id)
    )
    terminalTabs.push(...legacyTabs)
    retirePurgedTabLaunches(
      s,
      worktreeId,
      legacyTabs,
      (s.unifiedTabsByWorktree[worktreeId] ?? []).filter((tab) => removed.otherTabIds.has(tab.id)),
      cancelledSessionIds
    )
  }
  // Why: a hydrated terminal can exist only as a unified tab, with no legacy row.
  for (const tabId of removed.terminalTabIds) {
    if (!terminalTabs.some((tab) => tab.id === tabId)) {
      terminalTabs.push({ id: tabId, ptyId: null })
    }
  }
  // Why: a preview keys its source's editor state, unless a surviving file still uses that source.
  const survivingFiles = s.openFiles.filter((file) => !removed.fileIds.has(file.id))
  const previewSourceIds = s.openFiles.flatMap((file) =>
    removed.fileIds.has(file.id) &&
    file.markdownPreviewSourceFileId &&
    !survivingFiles.some(
      (other) =>
        other.id === file.markdownPreviewSourceFileId ||
        other.markdownPreviewSourceFileId === file.markdownPreviewSourceFileId
    )
      ? [file.markdownPreviewSourceFileId]
      : []
  )
  const doomed = collectSurfacePurgeDoomedIds(s, {
    tabs: terminalTabs,
    browserWorkspaceIds: removed.browserTabIds,
    fileIds: [...removed.fileIds, ...previewSourceIds]
  })
  // Why: a PTY a kept tab still binds stays live, so its PTY-keyed state must stay with it.
  for (const worktreeId of twinIds) {
    for (const tab of s.tabsByWorktree[worktreeId] ?? []) {
      if (!doomed.doomedTabIds.has(tab.id)) {
        for (const ptyId of collectPtyIdsForTab(s, tab.id, tab.ptyId)) {
          doomed.doomedPtyIds.delete(ptyId)
        }
      }
    }
  }
  const omitters = createWorktreePurgeOmitters(s, new Set(), doomed)
  const tabPrefixedSleeping = {
    sleepingAgentSessionsByPaneKey: omitters.omitByPaneKeyTabPrefix(
      s.sleepingAgentSessionsByPaneKey
    ),
    agentLaunchConfigByPaneKey: omitters.omitByPaneKeyTabPrefix(s.agentLaunchConfigByPaneKey)
  }
  // Why SSH only: a record whose tab is gone names its host just by connection; null is ambiguous.
  const sshRecordPaneKeys = Object.entries(s.sleepingAgentSessionsByPaneKey ?? {}).flatMap(
    ([paneKey, record]) =>
      twinIds.has(record.worktreeId) &&
      record.connectionId &&
      canonical(record.worktreeId)(toSshExecutionHostId(record.connectionId)) === hostId
        ? [paneKey]
        : []
  )
  const layout = removeWorktreeLayout(s, {
    worktreeIds: new Set(),
    tabIds: doomed.doomedTabIds,
    activeFileCleared: s.activeFileId != null && removed.fileIds.has(s.activeFileId),
    kept: {
      worktreeIds: twinIds,
      terminalTabIds: removed.terminalTabIds,
      fileIds: removed.fileIds,
      browserTabIds: removed.browserTabIds,
      unifiedTabIds: removed.otherTabIds
    }
  })
  const active = s.activeWorktreeId && twinIds.has(s.activeWorktreeId) ? s.activeWorktreeId : null
  // Why only then: re-deriving an untouched selection could switch the visible surface.
  const selectionRemoved =
    active !== null &&
    ((s.activeTabId != null && removed.terminalTabIds.has(s.activeTabId)) ||
      (s.activeFileId != null && removed.fileIds.has(s.activeFileId)) ||
      (s.activeBrowserTabId != null && removed.browserTabIds.has(s.activeBrowserTabId)) ||
      (layout.groupsByWorktree[active] ?? []).some(
        (group, index) => group.activeTabId !== s.groupsByWorktree[active]?.[index]?.activeTabId
      ))
  return {
    ...layout,
    // Why: a group may now show a surviving tab of another kind, so selection is derived again.
    ...(selectionRemoved ? buildActiveSurfacePatch({ ...s, ...layout }, active) : {}),
    ...buildWorktreePurgeSurfacePatch(s, omitters, doomed.doomedTabIds, {
      ...tabPrefixedSleeping,
      ...omitSleepingAgentSessionsForWorktrees(tabPrefixedSleeping, new Set(), sshRecordPaneKeys)
    }),
    ...twinSelectionPatch(s, twinHostIds, hostId)
  }
}
