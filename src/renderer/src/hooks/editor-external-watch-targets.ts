import type { AppState } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { appendLocalDocumentDirectoryWatchTargets } from './editor-document-directory-watch-targets'
import {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner
} from './editor-external-watch-target-identity'

export {
  getEditorExternalWatchTargetKey,
  getOpenFileRuntimeOwner
} from './editor-external-watch-target-identity'

export type EditorExternalWatchTarget = {
  worktreeId: string
  worktreePath: string
  connectionId: string | undefined
  runtimeEnvironmentId: string | null
  allowLocalWindowsWslAliases?: true
  shallow?: true
}

export type EditorExternalWatchTargetState = Pick<
  AppState,
  | 'openFiles'
  | 'worktreesByRepo'
  | 'repos'
  | 'activeWorktreeId'
  | 'settings'
  | 'rightSidebarOpen'
  | 'rightSidebarTab'
  | 'rightSidebarExplorerView'
  | 'gitStatusHugeByWorktree'
  | 'sshConnectionStates'
  | 'folderWorkspaces'
  | 'projectGroups'
>

type WatchedTargetsSnapshot = {
  targets: EditorExternalWatchTarget[]
  targetsKey: string
}

let cachedOpenFiles: AppState['openFiles'] | null = null
let cachedWorktreesByRepo: AppState['worktreesByRepo'] | null = null
let cachedRepos: AppState['repos'] | null = null
let cachedActiveWorktreeId: string | null = null
let cachedRuntimeEnvironmentId: string | undefined
let cachedRightSidebarOpen: boolean | null = null
let cachedRightSidebarTab: AppState['rightSidebarTab'] | null = null
let cachedRightSidebarExplorerView: AppState['rightSidebarExplorerView'] | null = null
let cachedGitStatusHugeByWorktree: AppState['gitStatusHugeByWorktree'] | null = null
let cachedSshConnectionStates: AppState['sshConnectionStates'] | null = null
let cachedFolderWorkspaces: AppState['folderWorkspaces'] | null = null
let cachedProjectGroups: AppState['projectGroups'] | null = null
let cachedWatchedTargetsSnapshot: WatchedTargetsSnapshot = { targets: [], targetsKey: '' }

export function getLocalWindowsWslAliasOption(
  target: Pick<EditorExternalWatchTarget, 'allowLocalWindowsWslAliases'>
): Pick<EditorExternalWatchTarget, 'allowLocalWindowsWslAliases'> {
  return isLocalWindowsDesktopClient() && target.allowLocalWindowsWslAliases === true
    ? { allowLocalWindowsWslAliases: true }
    : {}
}

function isLocalHostStamp(value: string | null | undefined): boolean {
  return parseExecutionHostId(value)?.kind === 'local'
}

function canWatchNativeLocalOwner(args: {
  worktreePath: string
  runtimeEnvironmentId: string | null
  connectionId: string | null | undefined
  worktree: AppState['worktreesByRepo'][string][number] | undefined
  repo: AppState['repos'][number] | undefined
  folderWorkspace: AppState['folderWorkspaces'][number] | undefined
  projectGroup: AppState['projectGroups'][number] | undefined
}): boolean {
  if (args.runtimeEnvironmentId !== null || args.connectionId !== null) {
    return false
  }
  if (args.worktree) {
    return (
      !!args.repo &&
      !args.worktree.runtimeOwnerEnvironmentId?.trim() &&
      isLocalHostStamp(args.worktree.hostId) &&
      isLocalHostStamp(args.repo.executionHostId)
    )
  }
  return (
    !!args.folderWorkspace &&
    isLocalHostStamp(args.folderWorkspace.executionHostId) &&
    isLocalHostStamp(args.projectGroup?.executionHostId)
  )
}

export function selectEditorExternalWatchTargets(
  state: EditorExternalWatchTargetState
): WatchedTargetsSnapshot {
  const runtimeEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() || undefined
  if (
    cachedOpenFiles === state.openFiles &&
    cachedWorktreesByRepo === state.worktreesByRepo &&
    cachedRepos === state.repos &&
    cachedActiveWorktreeId === state.activeWorktreeId &&
    cachedRuntimeEnvironmentId === runtimeEnvironmentId &&
    cachedRightSidebarOpen === state.rightSidebarOpen &&
    cachedRightSidebarTab === state.rightSidebarTab &&
    cachedRightSidebarExplorerView === state.rightSidebarExplorerView &&
    cachedGitStatusHugeByWorktree === state.gitStatusHugeByWorktree &&
    cachedSshConnectionStates === state.sshConnectionStates &&
    cachedFolderWorkspaces === state.folderWorkspaces &&
    cachedProjectGroups === state.projectGroups
  ) {
    return cachedWatchedTargetsSnapshot
  }

  const targetOwnersByWorktreeId = new Map<string, Set<string | null>>()
  // Why: watcher ownership is scoped by worktree + runtime owner — the same path can be open locally and in a runtime workspace, and reads/saves already route per owner.
  for (const file of state.openFiles) {
    let owners = targetOwnersByWorktreeId.get(file.worktreeId)
    if (!owners) {
      owners = new Set()
      targetOwnersByWorktreeId.set(file.worktreeId, owners)
    }
    // Why: persisted/restored tabs may have runtimeEnvironmentId undefined; new openFile calls resolve inheritance before storing, so an ownerless tab stays local.
    owners.add(getOpenFileRuntimeOwner(file))
  }
  const activeWorktreeId = state.activeWorktreeId
  const activeWorktree = activeWorktreeId
    ? findWorktreeById(state.worktreesByRepo, activeWorktreeId)
    : undefined
  const activeWorktreeHost = parseExecutionHostId(activeWorktree?.hostId)
  const activeRepo = activeWorktree
    ? activeWorktreeHost?.kind === 'local'
      ? (findRepoForHost(state.repos, activeWorktree.repoId, {
          hostId: activeWorktreeHost.id
        }) ?? undefined)
      : state.repos.find((repo) => repo.id === activeWorktree.repoId)
    : undefined
  const sourceControlCanConsumeWatch =
    !!activeWorktreeId &&
    !!activeRepo &&
    isGitRepoKind(activeRepo) &&
    !state.gitStatusHugeByWorktree[activeWorktreeId] &&
    (!activeRepo.connectionId ||
      state.sshConnectionStates.get(activeRepo.connectionId)?.status === 'connected')
  const activeWorktreeNeedsSidebarWatch =
    activeWorktreeId !== null &&
    state.rightSidebarOpen &&
    ((state.rightSidebarTab === 'explorer' && state.rightSidebarExplorerView === 'files') ||
      (state.rightSidebarTab === 'source-control' && sourceControlCanConsumeWatch))
  if (activeWorktreeNeedsSidebarWatch) {
    // Why: this app-level watcher owns Explorer/Source-Control subscriptions so downstream consumers don't fight over watch/unwatch IPC.
    let owners = targetOwnersByWorktreeId.get(activeWorktreeId)
    if (!owners) {
      owners = new Set()
      targetOwnersByWorktreeId.set(activeWorktreeId, owners)
    }
    // Why: sidebar watcher must follow the selected worktree's host owner, not the host currently focused in the UI.
    owners.add(getRuntimeEnvironmentIdForWorktree(state, activeWorktreeId))
  }

  const nextTargets: EditorExternalWatchTarget[] = []
  const localDocumentOwners = new Set([FLOATING_TERMINAL_WORKTREE_ID])
  const sortedWorktreeIds = Array.from(targetOwnersByWorktreeId.keys()).sort()
  for (const id of sortedWorktreeIds) {
    const worktree = findWorktreeById(state.worktreesByRepo, id)
    const workspaceScope = parseWorkspaceKey(id)
    const folderWorkspace =
      workspaceScope?.type === 'folder'
        ? state.folderWorkspaces.find(
            (workspace) => workspace.id === workspaceScope.folderWorkspaceId
          )
        : undefined
    if (!worktree && !folderWorkspace) {
      continue
    }
    const worktreeHost = parseExecutionHostId(worktree?.hostId)
    const repo = worktree
      ? worktreeHost?.kind === 'local'
        ? (findRepoForHost(state.repos, worktree.repoId, { hostId: worktreeHost.id }) ?? undefined)
        : state.repos.find((candidate) => candidate.id === worktree.repoId)
      : undefined
    const folderHostId = parseExecutionHostId(folderWorkspace?.executionHostId)?.id
    const projectGroup = folderWorkspace
      ? state.projectGroups.find(
          (group) =>
            group.id === folderWorkspace.projectGroupId &&
            parseExecutionHostId(group.executionHostId)?.id === folderHostId
        )
      : undefined
    const connectionId = folderWorkspace
      ? getFolderWorkspaceConnectionId(state, folderWorkspace.id)
      : repo
        ? (repo.connectionId ?? null)
        : undefined
    if (connectionId === undefined && folderWorkspace) {
      continue
    }
    const owners = Array.from(targetOwnersByWorktreeId.get(id) ?? []).sort((left, right) =>
      (left ?? '').localeCompare(right ?? '')
    )
    for (const owner of owners) {
      const isNativeLocalOwner = canWatchNativeLocalOwner({
        worktreePath: worktree?.path ?? folderWorkspace!.folderPath,
        runtimeEnvironmentId: owner,
        connectionId,
        worktree,
        repo,
        folderWorkspace,
        projectGroup
      })
      if (isNativeLocalOwner) {
        localDocumentOwners.add(id)
      }
      const target = {
        worktreeId: id,
        worktreePath: worktree?.path ?? folderWorkspace!.folderPath,
        connectionId: connectionId ?? undefined,
        runtimeEnvironmentId: owner,
        ...(isNativeLocalOwner &&
        isWindowsAbsolutePathLike(worktree?.path ?? folderWorkspace!.folderPath)
          ? { allowLocalWindowsWslAliases: true as const }
          : {})
      }
      nextTargets.push(target)
    }
  }

  appendLocalDocumentDirectoryWatchTargets(state.openFiles, nextTargets, localDocumentOwners)
  const targetsKey = nextTargets.map(getEditorExternalWatchTargetKey).join('|')
  cachedOpenFiles = state.openFiles
  cachedWorktreesByRepo = state.worktreesByRepo
  cachedRepos = state.repos
  cachedActiveWorktreeId = state.activeWorktreeId
  cachedRuntimeEnvironmentId = runtimeEnvironmentId
  cachedRightSidebarOpen = state.rightSidebarOpen
  cachedRightSidebarTab = state.rightSidebarTab
  cachedRightSidebarExplorerView = state.rightSidebarExplorerView
  cachedGitStatusHugeByWorktree = state.gitStatusHugeByWorktree
  cachedSshConnectionStates = state.sshConnectionStates
  cachedFolderWorkspaces = state.folderWorkspaces
  cachedProjectGroups = state.projectGroups

  if (targetsKey === cachedWatchedTargetsSnapshot.targetsKey) {
    return cachedWatchedTargetsSnapshot
  }

  cachedWatchedTargetsSnapshot = { targets: nextTargets, targetsKey }
  return cachedWatchedTargetsSnapshot
}
