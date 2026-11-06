/** Brings back, after a reload, the chats of launches this window saved but no longer shows: at
 *  startup from the saved rows, and later once a host's listing names a host launch's workspace. */

import {
  findIndexedProjectGroupOwner,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost,
  getCatalogOwnerHostId
} from '../../worktree-runtime-owner-index'
import { findIndexedRepoOwner } from '../../repo-owner-index'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { StructuredAgentLaunchPersistedRecord } from './structured-agent-session-launch-record'
import {
  readStructuredAgentLaunchRecords,
  structuredAgentLaunchRecordsRevision
} from './structured-agent-session-launch-persistence'
import {
  getStructuredAgentSessionLaunchOwner,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import {
  batchStructuredLaunchSurfaces,
  materializeStructuredLaunchSurface,
  openStructuredAgentSessionProvisionalTab,
  reserveStructuredLaunchSlot,
  structuredLaunchTabShown
} from './structured-agent-session-launch-surface'
import type { AppState } from '@/store/types'
import type { Worktree } from '../../../../../shared/worktree/types'

export function restoreStructuredLaunchSurfaces(): void {
  restoreLaunchSurfaces(readStructuredAgentLaunchRecords())
}

type OwedHostLaunches = Map<ExecutionHostId, Map<string, StructuredAgentLaunchPersistedRecord[]>>
// Saved host launches by host and workspace, derived from the saved rows and rebuilt only once
// they change, so each listing visits just the launches in the workspaces it names.
let owedIndex: { revision: number; owed: OwedHostLaunches } | undefined

function owedHostLaunches(): OwedHostLaunches {
  const revision = structuredAgentLaunchRecordsRevision()
  if (owedIndex?.revision !== revision) {
    const owed: OwedHostLaunches = new Map()
    for (const record of readStructuredAgentLaunchRecords()) {
      const worktreeId = record.surfaceAddress?.worktreeId
      if (record.hostLaunchOperationId === undefined || !worktreeId) {
        continue
      }
      const byWorkspace = owed.get(record.executionHostId) ?? new Map()
      owed.set(record.executionHostId, byWorkspace)
      const inWorkspace = byWorkspace.get(worktreeId)
      if (inWorkspace) {
        inWorkspace.push(record)
      } else {
        byWorkspace.set(worktreeId, [record])
      }
    }
    owedIndex = { revision, owed }
  }
  return owedIndex.owed
}

/** A host's listing settled: its saved launches this window does not hold come back where the
 *  listing names their workspace. Another host's listing, or one naming other workspaces, neither
 *  shows nor ends them. */
export function restoreStructuredLaunchSurfacesListedBy(
  hostId: ExecutionHostId,
  listedWorktreeIds: Iterable<string>
): void {
  const byWorkspace = owedHostLaunches().get(hostId)
  if (!byWorkspace) {
    return
  }
  const owed: StructuredAgentLaunchPersistedRecord[] = []
  for (const worktreeId of new Set(listedWorktreeIds)) {
    for (const record of byWorkspace.get(worktreeId) ?? []) {
      if (!getStructuredLaunchStateBySessionId(record.sessionId)) {
        owed.push(record)
      }
    }
  }
  restoreLaunchSurfaces(owed)
}

/** Only a chat not already showing on its own host is drawn; a shown one costs no catalog read,
 *  slot, tab or save. Nothing about being shown is saved: the tab list itself says so. */
function restoreLaunchSurfaces(records: readonly StructuredAgentLaunchPersistedRecord[]): void {
  const unshown = records.filter(
    (record) =>
      record.surfaceAddress &&
      !structuredLaunchTabShown({
        worktreeId: record.surfaceAddress.worktreeId,
        sessionId: record.sessionId,
        executionHostId: record.executionHostId
      })
  )
  if (unshown.length > 0) {
    batchStructuredLaunchSurfaces(() => drawLaunchSurfaces(unshown))
  }
}

type LaunchCatalog = { workspaces: Worktree[] }
// The catalog the launches are placed against, kept while the store's listings it reads are
// unchanged, so its owner index is built once per listing change rather than once per draw.
const catalogs = new WeakMap<
  AppState['worktreesByRepo'],
  {
    folders: AppState['folderWorkspaces']
    groups: AppState['projectGroups']
    catalog: LaunchCatalog
  }
>()

function launchCatalog(state: AppState): LaunchCatalog {
  const cached = catalogs.get(state.worktreesByRepo)
  if (cached?.folders === state.folderWorkspaces && cached.groups === state.projectGroups) {
    return cached.catalog
  }
  const catalog = {
    workspaces: [
      ...state.allWorktrees(),
      ...selectFolderWorkspaces(state).flatMap((workspace) => {
        const group = findIndexedProjectGroupOwner(state.projectGroups, workspace.projectGroupId)
        const host = workspace.executionHostId || workspace.connectionId ? workspace : group
        const owned = host && { ...workspace, executionHostId: getCatalogOwnerHostId(host) }
        return owned ? [folderWorkspaceToWorktree(owned)] : []
      })
    ]
  }
  catalogs.set(state.worktreesByRepo, {
    folders: state.folderWorkspaces,
    groups: state.projectGroups,
    catalog
  })
  return catalog
}

function drawLaunchSurfaces(records: readonly StructuredAgentLaunchPersistedRecord[]): void {
  const state = useAppStore.getState()
  const catalog = launchCatalog(state)
  for (const record of records) {
    // A host launch's chat comes back failed or unknown, on its own host; others only as before.
    const hostLaunch = record.hostLaunchOperationId !== undefined
    if (
      !record.surfaceAddress ||
      (!hostLaunch &&
        (record.executionHostId !== 'local' || record.lifecycle !== 'visibility-unknown'))
    ) {
      continue
    }
    // Its own host's row first: another host listing the same workspace neither shows nor hides it.
    const workspace =
      findIndexedWorktreeOwnerForHost(
        catalog,
        record.surfaceAddress.worktreeId,
        record.executionHostId
      ) ?? findIndexedWorktreeOwner(catalog, record.surfaceAddress.worktreeId)
    const environmentId = workspace?.runtimeOwnerEnvironmentId?.trim()
    if (!workspace || (environmentId && !hostLaunch)) {
      continue
    }
    const repo = findIndexedRepoOwner(state.repos, workspace.repoId)
    const host = environmentId
      ? toRuntimeExecutionHostId(environmentId)
      : (workspace.hostId ?? (repo ? getCatalogOwnerHostId(repo) : undefined))
    if (
      host !== getStructuredAgentSessionLaunchOwner(record.sessionId) ||
      !structuredAgentSessionTargetForHost(record.executionHostId)
    ) {
      continue
    }
    reserveStructuredLaunchSlot(record)
    if (record.executionHostId === 'local') {
      materializeStructuredLaunchSurface(record, false)
    } else {
      // A paired host's own slot bookkeeping is not this window's; its chat is drawn as at launch.
      openStructuredAgentSessionProvisionalTab({
        worktreeId: record.surfaceAddress.worktreeId,
        executionHostId: record.executionHostId,
        sessionId: record.sessionId,
        agent: record.agent,
        ...(record.surfaceAddress.targetGroupId
          ? { targetGroupId: record.surfaceAddress.targetGroupId }
          : {}),
        activate: false
      })
    }
  }
}
