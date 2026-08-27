import type { AppState } from '@/store/types'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import {
  DASHBOARD_MAX_LABEL_LENGTH,
  type DashboardCard,
  type DashboardCardHostKind,
  type DashboardCardWorkspaceKind
} from '../../../../shared/dashboard-snapshot'
import type { RepoIcon } from '../../../../shared/repo-icon'
import {
  getWorktreeExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export type ActiveDashboardWorkspace = {
  projectId: string
  projectName: string
  repo: AppState['repos'][number] | null
  repoIcon: RepoIcon | null
  worktree: AppState['worktreesByRepo'][string][number] & { parentWorktreeId?: string | null }
  workspaceKind: DashboardCardWorkspaceKind
  remoteHostKind: Extract<DashboardCardHostKind, 'ssh' | 'remote'> | null
  hostLabel?: string
}

type DashboardWorkspaceState = Pick<AppState, 'repos' | 'worktreesByRepo'> &
  Partial<
    Pick<
      AppState,
      'folderWorkspaces' | 'projectGroups' | 'runtimeEnvironments' | 'settings' | 'sshTargetLabels'
    >
  >

function buildHostLabelLookup(
  state: DashboardWorkspaceState
): ReadonlyMap<ExecutionHostId, string> {
  const labels = new Map<ExecutionHostId, string>()
  for (const [targetId, label] of state.sshTargetLabels ?? []) {
    labels.set(toSshExecutionHostId(targetId), label)
  }
  for (const environment of state.runtimeEnvironments ?? []) {
    labels.set(toRuntimeExecutionHostId(environment.id), environment.name)
  }
  for (const [hostId, label] of getHostDisplayLabelOverrides(state.settings)) {
    labels.set(hostId, label)
  }
  return labels
}

function remoteHostKind(
  connectionId: string | null | undefined,
  executionHostId: string | null | undefined
): ActiveDashboardWorkspace['remoteHostKind'] {
  if (connectionId || executionHostId?.startsWith('ssh:')) {
    return 'ssh'
  }
  return executionHostId && executionHostId !== 'local' ? 'remote' : null
}

export function collectActiveDashboardWorkspaces(
  state: DashboardWorkspaceState,
  includeMapMetadata = true
): ActiveDashboardWorkspace[] {
  const workspaces: ActiveDashboardWorkspace[] = []
  const seenWorkspaceIds = new Set<string>()
  let hostLabels: ReadonlyMap<ExecutionHostId, string> | null = null
  const resolveHostLabel = (executionHostId: ExecutionHostId): string | undefined => {
    const parsed = includeMapMetadata ? parseExecutionHostId(executionHostId) : null
    if (parsed?.kind !== 'ssh' && parsed?.kind !== 'runtime') {
      return undefined
    }
    hostLabels ??= buildHostLabelLookup(state)
    const label =
      hostLabels.get(executionHostId) ??
      (parsed.kind === 'ssh' ? parsed.targetId : parsed.environmentId)
    return label.length > DASHBOARD_MAX_LABEL_LENGTH
      ? label.slice(0, DASHBOARD_MAX_LABEL_LENGTH)
      : label
  }

  for (const repo of state.repos ?? []) {
    for (const worktree of state.worktreesByRepo?.[repo.id] ?? []) {
      if (worktree.isArchived) {
        continue
      }
      seenWorkspaceIds.add(worktree.id)
      const workspaceHostLabel = includeMapMetadata
        ? resolveHostLabel(getWorktreeExecutionHostId(worktree, repo))
        : undefined
      workspaces.push({
        projectId: repo.id,
        projectName: repo.displayName,
        repo,
        repoIcon: repo.repoIcon ?? null,
        worktree,
        workspaceKind: includeMapMetadata && isFolderRepo(repo) ? 'folder' : 'worktree',
        remoteHostKind: includeMapMetadata
          ? remoteHostKind(repo.connectionId, worktree.hostId ?? repo.executionHostId)
          : null,
        ...(workspaceHostLabel ? { hostLabel: workspaceHostLabel } : {})
      })
    }
  }

  const projectGroupsById = new Map(
    (state.projectGroups ?? []).map((projectGroup) => [projectGroup.id, projectGroup])
  )
  for (const folderWorkspace of state.folderWorkspaces ?? []) {
    const worktree = folderWorkspaceToWorktree(folderWorkspace)
    if (folderWorkspace.isArchived || seenWorkspaceIds.has(worktree.id)) {
      continue
    }
    const projectGroup = projectGroupsById.get(folderWorkspace.projectGroupId)
    const workspaceHostLabel = includeMapMetadata
      ? resolveHostLabel(getWorktreeExecutionHostId(worktree, undefined))
      : undefined
    workspaces.push({
      projectId: `folder-workspace:${folderWorkspace.projectGroupId}`,
      projectName: projectGroup?.name ?? folderWorkspace.name,
      repo: null,
      repoIcon: null,
      worktree,
      workspaceKind: 'folder',
      remoteHostKind: includeMapMetadata
        ? remoteHostKind(
            folderWorkspace.connectionId ?? projectGroup?.connectionId,
            worktree.hostId ?? projectGroup?.executionHostId
          )
        : null,
      ...(workspaceHostLabel ? { hostLabel: workspaceHostLabel } : {})
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
  hostLabel?: string
} {
  return {
    hostKind: dashboardCardHostKind(workspace, ptyId, terminalInput, clientPlatform),
    executionHostId: getWorktreeExecutionHostId(workspace.worktree, workspace.repo ?? undefined),
    workspaceKind: workspace.workspaceKind,
    ...(workspace.hostLabel ? { hostLabel: workspace.hostLabel } : {})
  }
}
