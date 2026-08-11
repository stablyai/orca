import type { AppState } from '@/store/types'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import type {
  DashboardCard,
  DashboardCardHostKind,
  DashboardCardWorkspaceKind
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { resolveDashboardFolderCatalogOwner } from './dashboard-folder-catalog-owner'
import {
  dashboardRepoProjectId,
  resolveDashboardRepoCatalogOwner
} from './dashboard-repo-catalog-owner'

export type ActiveDashboardWorkspace = {
  projectId: string
  projectName: string
  repo: AppState['repos'][number] | null
  repoIcon: RepoIcon | null
  worktree: AppState['worktreesByRepo'][string][number] & { parentWorktreeId?: string | null }
  executionHostId: ExecutionHostId
  workspaceKind: DashboardCardWorkspaceKind
  remoteHostKind: Extract<DashboardCardHostKind, 'ssh' | 'remote'> | null
}

type DashboardWorkspaceState = Pick<AppState, 'repos' | 'worktreesByRepo'> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups'>>

function remoteHostKind(
  connectionId: string | null | undefined,
  executionHostId: string | null | undefined
): ActiveDashboardWorkspace['remoteHostKind'] {
  if (connectionId || executionHostId?.startsWith('ssh:')) {
    return 'ssh'
  }
  return executionHostId && executionHostId !== 'local' ? 'remote' : null
}

function folderProjectId(
  projectGroupIdCounts: ReadonlyMap<string, number>,
  folderWorkspace: AppState['folderWorkspaces'][number],
  projectGroup: AppState['projectGroups'][number] | null,
  executionHostId: ExecutionHostId
): string {
  const baseId = `folder-workspace:${folderWorkspace.projectGroupId}`
  if (!projectGroup || (projectGroupIdCounts.get(projectGroup.id) ?? 0) < 2) {
    return baseId
  }
  const physicalHostId =
    parseExecutionHostId(projectGroup.runtimeSourceExecutionHostId)?.id ??
    parseExecutionHostId(folderWorkspace.runtimeSourceExecutionHostId)?.id ??
    executionHostId
  return `${baseId}@${encodeURIComponent(physicalHostId)}`
}

export function collectActiveDashboardWorkspaces(
  state: DashboardWorkspaceState,
  includeMapMetadata = true
): ActiveDashboardWorkspace[] {
  const workspaces: ActiveDashboardWorkspace[] = []
  const seenWorkspaceIds = new Set<string>()
  const reposById = new Map<string, AppState['repos']>()
  for (const repo of state.repos ?? []) {
    const candidates = reposById.get(repo.id)
    if (candidates) {
      candidates.push(repo)
    } else {
      reposById.set(repo.id, [repo])
    }
  }
  const worktreeIdCounts = new Map<string, number>()
  for (const worktrees of Object.values(state.worktreesByRepo ?? {})) {
    for (const worktree of worktrees) {
      worktreeIdCounts.set(worktree.id, (worktreeIdCounts.get(worktree.id) ?? 0) + 1)
    }
  }
  for (const [repoId, worktrees] of Object.entries(state.worktreesByRepo ?? {})) {
    const repoCandidates = reposById.get(repoId) ?? []
    for (const worktree of worktrees) {
      if (worktree.isArchived || worktreeIdCounts.get(worktree.id) !== 1) {
        continue
      }
      const countOnlyRepo =
        !includeMapMetadata && repoCandidates.length === 1 ? repoCandidates[0] : null
      const owner = countOnlyRepo
        ? null
        : resolveDashboardRepoCatalogOwner(repoCandidates, worktree)
      if (!countOnlyRepo && !owner) {
        continue
      }
      const repo = countOnlyRepo ?? owner?.repo
      if (!repo) {
        continue
      }
      seenWorkspaceIds.add(worktree.id)
      workspaces.push({
        projectId: owner ? dashboardRepoProjectId(owner) : repo.id,
        projectName: repo.displayName,
        repo,
        repoIcon: repo.repoIcon ?? null,
        worktree,
        executionHostId: owner ? getWorktreeExecutionHostId(worktree, repo) : 'local',
        workspaceKind: includeMapMetadata && isFolderRepo(repo) ? 'folder' : 'worktree',
        remoteHostKind: includeMapMetadata
          ? remoteHostKind(repo.connectionId, worktree.hostId ?? repo.executionHostId)
          : null
      })
    }
  }

  const folderWorkspaces = state.folderWorkspaces ?? []
  const projectGroups = state.projectGroups ?? []
  const folderIdCounts = new Map<string, number>()
  const projectGroupIdCounts = new Map<string, number>()
  for (const folderWorkspace of folderWorkspaces) {
    folderIdCounts.set(folderWorkspace.id, (folderIdCounts.get(folderWorkspace.id) ?? 0) + 1)
  }
  for (const projectGroup of projectGroups) {
    projectGroupIdCounts.set(projectGroup.id, (projectGroupIdCounts.get(projectGroup.id) ?? 0) + 1)
  }
  for (const folderWorkspace of folderWorkspaces) {
    if (folderIdCounts.get(folderWorkspace.id) !== 1) {
      continue
    }
    const owner = resolveDashboardFolderCatalogOwner(
      { folderWorkspaces, projectGroups },
      folderWorkspace.id
    )
    if (!owner) {
      continue
    }
    const { folderWorkspace: resolvedFolder, projectGroup, executionHostId } = owner
    const worktree = folderWorkspaceToWorktree(resolvedFolder)
    if (resolvedFolder.isArchived || seenWorkspaceIds.has(worktree.id)) {
      continue
    }
    workspaces.push({
      projectId: folderProjectId(
        projectGroupIdCounts,
        resolvedFolder,
        projectGroup,
        executionHostId
      ),
      projectName: projectGroup?.name ?? resolvedFolder.name,
      repo: null,
      repoIcon: null,
      worktree,
      executionHostId,
      workspaceKind: 'folder',
      remoteHostKind: includeMapMetadata ? remoteHostKind(null, executionHostId) : null
    })
  }
  return workspaces
}

export function dashboardCardHostKind(
  workspace: ActiveDashboardWorkspace,
  ptyId: string | null,
  terminalInput: DashboardCard['terminalInput'],
  clientPlatform: NodeJS.Platform
): DashboardCardHostKind {
  if (workspace.remoteHostKind) {
    return workspace.remoteHostKind
  }
  if (ptyId && parseAppSshPtyId(ptyId)) {
    return 'ssh'
  }
  if (ptyId && getRemoteRuntimePtyEnvironmentId(ptyId)) {
    return 'remote'
  }
  return clientPlatform === 'win32' && terminalInput?.hostPlatform === 'linux' ? 'wsl' : 'local'
}

export function dashboardCardMapWorkspaceMetadata(
  workspace: ActiveDashboardWorkspace,
  ptyId: string | null,
  terminalInput: DashboardCard['terminalInput'],
  clientPlatform: NodeJS.Platform
): {
  hostKind: DashboardCardHostKind
  executionHostId: ExecutionHostId
  workspaceKind: DashboardCardWorkspaceKind
} {
  return {
    hostKind: dashboardCardHostKind(workspace, ptyId, terminalInput, clientPlatform),
    executionHostId: workspace.executionHostId,
    workspaceKind: workspace.workspaceKind
  }
}
