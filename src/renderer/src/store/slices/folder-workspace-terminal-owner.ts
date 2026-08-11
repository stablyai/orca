import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { FolderWorkspace, ProjectGroup, TerminalTab } from '../../../../shared/types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import type { AppState } from '../types'

export type FolderWorkspaceTerminalOwner =
  | { kind: 'local' }
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }

type FolderWorkspaceTerminalPtyState = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
  | 'lastKnownRelayPtyIdByTabId'
  | 'deferredSshSessionIdsByTabId'
  | 'directSshLivePtyBindingByTabId'
  | 'pendingReconnectPtyIdByTabId'
>

type FolderWorkspaceTerminalTabOwnershipState = FolderWorkspaceTerminalPtyState &
  Pick<
    AppState,
    | 'activeWorktreeId'
    | 'activeWorkspaceKey'
    | 'activeWorkspaceExecutionHostId'
    | 'activeTabId'
    | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  >

export function folderWorkspaceTerminalOwnerOwnsPty(
  owner: FolderWorkspaceTerminalOwner,
  ptyId: string
): boolean {
  if (owner.kind === 'runtime') {
    const remote = parseRemoteRuntimePtyId(ptyId)
    return remote?.environmentId === owner.environmentId && Boolean(remote.handle)
  }
  const ssh = parseAppSshPtyId(ptyId)
  if (owner.kind === 'ssh') {
    return ssh?.connectionId === owner.targetId
  }
  return !ptyId.startsWith('remote:') && !ptyId.startsWith('ssh:') && !ssh
}

export function collectFolderWorkspaceTerminalTabPtyIds(
  state: FolderWorkspaceTerminalPtyState,
  tab: Pick<TerminalTab, 'id' | 'ptyId'>
): string[] {
  return [
    ...new Set(
      [
        ...(state.ptyIdsByTabId[tab.id] ?? []),
        tab.ptyId,
        ...Object.values(state.terminalLayoutsByTabId[tab.id]?.ptyIdsByLeafId ?? {}),
        state.lastKnownRelayPtyIdByTabId[tab.id],
        state.deferredSshSessionIdsByTabId[tab.id],
        state.directSshLivePtyBindingByTabId[tab.id]?.ptyId,
        state.pendingReconnectPtyIdByTabId[tab.id]
      ].filter((ptyId): ptyId is string => Boolean(ptyId))
    )
  ]
}

export function folderWorkspaceTerminalTabBelongsToOwner(
  state: FolderWorkspaceTerminalTabOwnershipState,
  workspaceKey: string,
  tabId: string,
  owner: FolderWorkspaceTerminalOwner,
  ownerHostId: ExecutionHostId
): boolean {
  const tab = (state.tabsByWorktree[workspaceKey] ?? []).find((candidate) => candidate.id === tabId)
  if (!tab) {
    return false
  }
  const ptyIds = collectFolderWorkspaceTerminalTabPtyIds(state, tab)
  if (ptyIds.length > 0) {
    return ptyIds.every((ptyId) => folderWorkspaceTerminalOwnerOwnsPty(owner, ptyId))
  }
  if (
    state.activeTabId !== tabId ||
    (state.activeWorktreeId !== workspaceKey && state.activeWorkspaceKey !== workspaceKey)
  ) {
    return false
  }
  return state.activeWorkspaceExecutionHostId === null
    ? state.restoredRuntimeHostIdByWorkspaceSessionKey[workspaceKey] === ownerHostId
    : state.activeWorkspaceExecutionHostId === ownerHostId
}

function projectGroupHostId(group: ProjectGroup): ExecutionHostId {
  return (
    parseExecutionHostId(group.executionHostId)?.id ??
    (group.connectionId ? toSshExecutionHostId(group.connectionId) : LOCAL_EXECUTION_HOST_ID)
  )
}

function folderWorkspaceHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[]
): ExecutionHostId {
  const explicitHostId = parseExecutionHostId(workspace.executionHostId)?.id
  if (explicitHostId) {
    return explicitHostId
  }
  if (workspace.connectionId) {
    return toSshExecutionHostId(workspace.connectionId)
  }
  const matchingHosts = new Set(
    projectGroups.filter((group) => group.id === workspace.projectGroupId).map(projectGroupHostId)
  )
  return matchingHosts.size === 1
    ? ([...matchingHosts][0] as ExecutionHostId)
    : LOCAL_EXECUTION_HOST_ID
}

export function reconcileDeletedFolderWorkspaceActiveOwner(
  state: AppState,
  workspaceKey: string,
  removedHostId: ExecutionHostId
): Partial<AppState> | null {
  const restoredOwnerWasRemoved =
    state.restoredRuntimeHostIdByWorkspaceSessionKey[workspaceKey] === removedHostId
  const activeOwnerWasRemoved =
    (state.activeWorktreeId === workspaceKey || state.activeWorkspaceKey === workspaceKey) &&
    (state.activeWorkspaceExecutionHostId === removedHostId ||
      (state.activeWorkspaceExecutionHostId === null && restoredOwnerWasRemoved))
  if (!activeOwnerWasRemoved && !restoredOwnerWasRemoved) {
    return null
  }
  const survivingHostIds = new Set(
    state.folderWorkspaces
      .filter((workspace) => folderWorkspaceKey(workspace.id) === workspaceKey)
      .map((workspace) => folderWorkspaceHostId(workspace, state.projectGroups))
      .filter((hostId) => hostId !== removedHostId)
  )
  const survivingHostId = [...survivingHostIds].sort()[0] ?? null
  const restoredOwners = { ...state.restoredRuntimeHostIdByWorkspaceSessionKey }
  if (restoredOwnerWasRemoved) {
    if (survivingHostId && parseExecutionHostId(survivingHostId)?.kind === 'runtime') {
      restoredOwners[workspaceKey] = survivingHostId
    } else {
      delete restoredOwners[workspaceKey]
    }
  }
  return {
    ...(activeOwnerWasRemoved
      ? survivingHostId
        ? { activeWorkspaceExecutionHostId: survivingHostId }
        : {
            activeWorktreeId: null,
            activeWorkspaceKey: null,
            activeWorkspaceExecutionHostId: null,
            activeTabId: null,
            activeBrowserTabId: null,
            activeFileId: null,
            activeTabType: 'terminal' as const
          }
      : {}),
    ...(restoredOwnerWasRemoved
      ? { restoredRuntimeHostIdByWorkspaceSessionKey: restoredOwners }
      : {})
  }
}
