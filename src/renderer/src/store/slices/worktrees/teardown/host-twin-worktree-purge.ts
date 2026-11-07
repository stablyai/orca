import type { AppState } from '../../../types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../../../../shared/worktree/id'
import type { WorktreePurgeTarget } from './worktree-purge-target'
import '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getFolderWorkspaceHostId } from '../../../../../../shared/folder-workspaces/folder-workspace-host-id'
import { getProjectGroupHostId } from '../../../project-groups/project-group-owner-routing'
import {
  collectRemovedHostTwinState,
  removedHostCanonicalizer,
  twinSelectionPatch
} from '../../../repos/repo-removal-host-twin-attribution'
import { removeWorktreeLayout } from '../../tabs/worktree-layout-lifecycle'
import { buildActiveSurfacePatch } from '../../tabs/tabs-surface'
import { getRepoHostSummaries } from '../listing/worktree-host-ownership'
import { collectSurfacePurgeDoomedIds } from './worktree-purge-doomed-ids'
import { collectPtyIdsForTab } from '../../../terminals/terminal-tab-retirement'
import { createWorktreePurgeOmitters } from './worktree-purge-omitters'
import { omitSleepingAgentSessionsForWorktrees } from './sleeping-agent-session-omission'
import {
  cancelStructuredLaunchesForWorktrees,
  retirePurgedTabLaunches
} from './purged-structured-launch-retirement'
import { buildWorktreePurgeSurfacePatch } from './worktree-purge-surface-patch'
import { noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'
import { selectFolderWorkspaces } from '../../../workspaces/catalog/workspace-record-fields'

import {
  worktreePurgePublishers,
  type PurgePublisher
} from '../../../repos/repo-removal-publisher-index'

function purgedPublisherMatcher(
  s: AppState,
  repoId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
) {
  const positions = new Map([...purgedHosts].map((hostId, index) => [hostId, index]))
  const runtimeHostsByEnvironment = new Map<string, ExecutionHostId>()
  for (const hostId of purgedHosts) {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime' && !runtimeHostsByEnvironment.has(parsed.environmentId)) {
      runtimeHostsByEnvironment.set(parsed.environmentId, hostId)
    }
  }
  return (row: PurgePublisher): ExecutionHostId | undefined => {
    if (row.runtimeOwnerEnvironmentId) {
      return runtimeHostsByEnvironment.get(row.runtimeOwnerEnvironmentId)
    }
    if (row.hostId) {
      return purgedHosts.has(row.hostId) ? row.hostId : undefined
    }
    const localPosition = positions.get(LOCAL_EXECUTION_HOST_ID)
    if (localPosition === 0 || purgedHosts.size === 0) {
      return localPosition === 0 ? LOCAL_EXECUTION_HOST_ID : undefined
    }
    // Only legacy unhosted rows can need the sole-repo-owner fallback.
    const soleOwner = getRepoHostSummaries(s.repos).get(repoId)?.onlyHostId
    const ownerPosition = soleOwner ? positions.get(soleOwner) : undefined
    return ownerPosition !== undefined &&
      (localPosition === undefined || ownerPosition < localPosition)
      ? soleOwner
      : localPosition !== undefined
        ? LOCAL_EXECUTION_HOST_ID
        : undefined
  }
}

/** Resolve surviving publishers and purged attribution with listing rules; legacy unstamped and runtime-proxied SSH rows may be the purged copy, not twins. */
function resolvePurgedPublishers(
  s: AppState,
  workspaceId: string,
  purgedHosts: ReadonlySet<ExecutionHostId>
): { survivors: ExecutionHostId[]; attributedHostIds: Map<ExecutionHostId, ExecutionHostId> } {
  const scope = parseWorkspaceKey(workspaceId)
  const attributedHostIds = new Map([...purgedHosts].map((hostId) => [hostId, hostId]))
  if (scope?.type === 'folder') {
    const groups = s.projectGroups ?? []
    const hosts = (selectFolderWorkspaces(s) ?? [])
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
  const rows = worktreePurgePublishers(s, worktreeId).rows()
  const matchPurgedHost = purgedPublisherMatcher(s, repoId, purgedHosts)
  const survivors = new Set<ExecutionHostId>()
  for (const row of rows) {
    const purgedHost = matchPurgedHost(row)
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

/** Every host whose listing publishes this id; empty when no row names it. */
export function workspacePublishingHosts(s: AppState, workspaceId: string): ExecutionHostId[] {
  return resolvePurgedPublishers(s, workspaceId, new Set()).survivors
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
  twinHostIds: ReadonlyMap<string, readonly ExecutionHostId[]>,
  changedPaneKeys?: Set<string>
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
  const editorBufferKeepRequest = noticeRemovedUnsavedFiles(s, doomed.removedFileIds)
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
    editorBufferKeepRequest,
    ...layout,
    // Why: a group may now show a surviving tab of another kind, so selection is derived again.
    ...(selectionRemoved ? buildActiveSurfacePatch({ ...s, ...layout }, active) : {}),
    ...buildWorktreePurgeSurfacePatch(
      s,
      omitters,
      doomed.doomedTabIds,
      {
        ...tabPrefixedSleeping,
        ...omitSleepingAgentSessionsForWorktrees(tabPrefixedSleeping, new Set(), sshRecordPaneKeys)
      },
      changedPaneKeys
    ),
    ...twinSelectionPatch(s, twinHostIds, hostId)
  }
}
