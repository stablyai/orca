/** Brings back, after a reload, the chats of launches this window saved but no longer shows: at
 *  startup from the saved rows, and later once a host's listing names a host launch's workspace. */

import {
  findIndexedProjectGroupOwner,
  findIndexedWorktreeOwner,
  findIndexedWorktreeOwnerForHost,
  getCatalogOwnerHostId
} from '../../worktree-runtime-owner-index'
import { findIndexedRepoOwner } from '../../repo-owner-index'
import { folderWorkspaceToWorktree } from '../../../../../shared/folder-workspace-worktree'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import type { StructuredAgentLaunchPersistedRecord } from './structured-agent-session-launch-record'
import { readStructuredAgentLaunchRecords } from './structured-agent-session-launch-persistence'
import {
  getStructuredAgentSessionLaunchOwner,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'
import {
  materializeStructuredLaunchSurface,
  openStructuredAgentSessionProvisionalTab,
  reserveStructuredLaunchSlot
} from './structured-agent-session-launch-surface'

export function restoreStructuredLaunchSurfaces(): void {
  restoreLaunchSurfaces(readStructuredAgentLaunchRecords())
}

/** A host's listing settled: its saved launches this window does not hold come back where the
 *  listing now names their workspace. Another host's listing neither shows nor ends them. */
export function restoreStructuredLaunchSurfacesListedBy(hostId: ExecutionHostId): void {
  const owed = readStructuredAgentLaunchRecords().filter(
    (record) =>
      record.hostLaunchOperationId !== undefined &&
      record.executionHostId === hostId &&
      !getStructuredLaunchStateBySessionId(record.sessionId)
  )
  if (owed.length > 0) {
    restoreLaunchSurfaces(owed)
  }
}

function restoreLaunchSurfaces(records: readonly StructuredAgentLaunchPersistedRecord[]): void {
  const state = useAppStore.getState()
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
