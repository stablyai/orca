import type { Bot } from '../../../../../../shared/bot-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspaces/folder-workspace-types'
import { indexHiddenProjects } from '../../../../../../shared/project/catalog/hidden-projects'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Project, ProjectHostSetup } from '../../../../../../shared/project/project-types'
import { isFolderRepo } from '../../../../../../shared/repository/repo-kind'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'
import { getRepoMainWorktreeId } from '../../../../../../shared/worktree/id'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { AgentJournalWorkTarget } from '../../../../../../shared/agent-session/work-target/agent-session-work-target'
import {
  buildWorktreeSubtreeRows,
  compactPathTail,
  resolveHostLabel,
  resolveHostUnavailableReason,
  type BotWorkTargetTreeRow
} from './bot-work-target-tree-rows'

export {
  filterBotWorkTargetTree,
  rowMatchesBotWorkTargetQuery,
  type BotWorkTargetHostUnavailableReason,
  type BotWorkTargetTreeRow
} from './bot-work-target-tree-rows'

export type BuildBotWorkTargetTreeInput = {
  /** Execution host running the bot chat (`local` or `runtime:<environmentId>`). */
  botHostId: ExecutionHostId
  repos: readonly Repo[]
  projects?: readonly Project[]
  projectHostSetups?: readonly ProjectHostSetup[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[]>>
  worktreeLineageById?: Readonly<
    Record<string, Pick<WorktreeLineage, 'parentWorktreeId'> | undefined>
  >
  folderWorkspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  bots: readonly Bot[]
  runtimeEnvironments: readonly { id: string; name?: string | null }[]
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  sshTargetLabels: ReadonlyMap<string, string>
  sshConnectionStates: ReadonlyMap<string, { status: string }>
}

function folderWorkspaceHostId(workspace: FolderWorkspace): ExecutionHostId {
  if (workspace.executionHostId) {
    return workspace.executionHostId
  }
  return workspace.connectionId ? `ssh:${workspace.connectionId}` : LOCAL_EXECUTION_HOST_ID
}

/** Build the registered project & workspace tree for the bot chat target picker. */
export function buildBotWorkTargetTree(input: BuildBotWorkTargetTreeInput): BotWorkTargetTreeRow[] {
  const { worktreesByRepo, folderWorkspaces } = input
  const hidden = indexHiddenProjects(input.repos, LOCAL_EXECUTION_HOST_ID)
  const runtimeEnvNames = new Map(
    input.runtimeEnvironments
      .filter((env) => Boolean(env.name?.trim()))
      .map((env) => [env.id, env.name!.trim()])
  )
  const projectIdByHostAndRepo = new Map<string, string>()
  for (const setup of input.projectHostSetups ?? []) {
    projectIdByHostAndRepo.set(`${setup.hostId}\0${setup.repoId}`, setup.projectId)
  }

  const botHomeIds = new Set(input.bots.map((bot) => bot.folderWorkspaceId))
  const groupById = new Map(input.projectGroups.map((group) => [group.id, group]))
  // Exclude bot home groups identified by containing bot home workspaces.
  const botGroupIds = new Set<string>()
  for (const folder of folderWorkspaces) {
    if (botHomeIds.has(folder.id) && folder.projectGroupId) {
      botGroupIds.add(folder.projectGroupId)
    }
  }

  const visibleRepos = input.repos.filter(
    (repo) => !hidden.isRowHidden({ repoId: repo.id, hostId: getRepoExecutionHostId(repo) })
  )
  const repoNameCounts = new Map<string, number>()
  for (const repo of visibleRepos) {
    repoNameCounts.set(repo.displayName, (repoNameCounts.get(repo.displayName) ?? 0) + 1)
  }

  const sortedRepos = [...visibleRepos].sort((a, b) => {
    const aHost = getRepoExecutionHostId(a)
    const bHost = getRepoExecutionHostId(b)
    const aUnavailable = resolveHostUnavailableReason(
      input.botHostId,
      aHost,
      input.runtimeStatusByEnvironmentId,
      input.sshConnectionStates
    )
    const bUnavailable = resolveHostUnavailableReason(
      input.botHostId,
      bHost,
      input.runtimeStatusByEnvironmentId,
      input.sshConnectionStates
    )
    if (Boolean(aUnavailable) !== Boolean(bUnavailable)) {
      return aUnavailable ? 1 : -1
    }
    return (
      a.displayName.localeCompare(b.displayName) ||
      aHost.localeCompare(bHost) ||
      a.id.localeCompare(b.id)
    )
  })

  const rows: BotWorkTargetTreeRow[] = []
  for (const repo of sortedRepos) {
    const hostId = getRepoExecutionHostId(repo)
    const hostLabel = resolveHostLabel(hostId, runtimeEnvNames, input.sshTargetLabels)
    const hostUnavailableReason = resolveHostUnavailableReason(
      input.botHostId,
      hostId,
      input.runtimeStatusByEnvironmentId,
      input.sshConnectionStates
    )
    const projectId = projectIdByHostAndRepo.get(`${hostId}\0${repo.id}`)
    const folder = isFolderRepo(repo)
    // Runtime worktree creation rejects SSH Git repos; keep child existing SSH worktrees selectable.
    const projectUnavailableReason =
      hostUnavailableReason ??
      (!folder && parseExecutionHostId(hostId)?.kind === 'ssh'
        ? ('ssh-project-unsupported' as const)
        : undefined)
    const repoWorktrees = worktreesByRepo[repo.id] ?? []
    const folderWorktree = folder
      ? (repoWorktrees.find((worktree) => !worktree.isArchived) ?? undefined)
      : undefined
    const ambiguousName = (repoNameCounts.get(repo.displayName) ?? 0) > 1
    const projectRowId = `project:${hostId}:${repo.id}`
    const target: AgentJournalWorkTarget = {
      kind: 'project',
      hostId,
      ...(projectId ? { projectId } : {}),
      repoId: repo.id,
      repoKind: folder ? 'folder' : 'git',
      ...(folder
        ? {
            workspaceId: folderWorktree?.id ?? getRepoMainWorktreeId(repo),
            ...(folderWorktree?.instanceId
              ? { workspaceInstanceId: folderWorktree.instanceId }
              : {}),
            workspaceKind: 'folder' as const
          }
        : {}),
      displayName: repo.displayName,
      hostLabel
    }
    rows.push({
      id: projectRowId,
      parentRowId: null,
      depth: 0,
      kind: 'project',
      repoKind: folder ? 'folder' : 'git',
      ...(folder ? { workspaceKind: 'folder' as const } : {}),
      displayName: repo.displayName,
      detail: ambiguousName ? compactPathTail(repo.path) : folder ? 'Folder project' : undefined,
      hostId,
      hostLabel,
      ambiguousName,
      ...(projectUnavailableReason ? { unavailableReason: projectUnavailableReason } : {}),
      searchText: [repo.displayName, hostLabel, repo.path, folder ? 'folder' : 'git']
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
      target
    })
    if (!folder) {
      rows.push(
        ...buildWorktreeSubtreeRows(
          repoWorktrees,
          input.worktreeLineageById ?? {},
          repo,
          projectRowId,
          projectId,
          hostId,
          hostLabel,
          hostUnavailableReason
        )
      )
    }
  }

  const visibleFolders = folderWorkspaces.filter(
    (folder) =>
      !folder.isArchived &&
      !botHomeIds.has(folder.id) &&
      (!folder.projectGroupId || !botGroupIds.has(folder.projectGroupId))
  )
  const folderNameCounts = new Map<string, number>()
  for (const folder of visibleFolders) {
    folderNameCounts.set(folder.name, (folderNameCounts.get(folder.name) ?? 0) + 1)
  }
  const sortedFolders = [...visibleFolders].sort((a, b) => {
    const aHost = folderWorkspaceHostId(a)
    const bHost = folderWorkspaceHostId(b)
    return a.name.localeCompare(b.name) || aHost.localeCompare(bHost) || a.id.localeCompare(b.id)
  })
  for (const folder of sortedFolders) {
    const hostId = folderWorkspaceHostId(folder)
    const hostLabel = resolveHostLabel(hostId, runtimeEnvNames, input.sshTargetLabels)
    const unavailableReason = resolveHostUnavailableReason(
      input.botHostId,
      hostId,
      input.runtimeStatusByEnvironmentId,
      input.sshConnectionStates
    )
    const groupName = folder.projectGroupId ? groupById.get(folder.projectGroupId)?.name : undefined
    const workspaceId = folderWorkspaceKey(folder.id)
    const ambiguousName = (folderNameCounts.get(folder.name) ?? 0) > 1
    const target: AgentJournalWorkTarget = {
      kind: 'workspace',
      hostId,
      workspaceId,
      workspaceKind: 'folder',
      displayName: folder.name,
      ...(groupName ? { projectName: groupName } : {}),
      hostLabel
    }
    rows.push({
      id: `workspace:${hostId}:${workspaceId}`,
      parentRowId: null,
      depth: 0,
      kind: 'workspace',
      workspaceKind: 'folder',
      displayName: folder.name,
      detail: ambiguousName
        ? compactPathTail(folder.folderPath)
        : groupName
          ? `${groupName} · Folder`
          : 'Folder workspace',
      hostId,
      hostLabel,
      ambiguousName,
      ...(unavailableReason ? { unavailableReason } : {}),
      searchText: [folder.name, groupName, hostLabel, folder.folderPath, 'folder']
        .filter(Boolean)
        .join(' ')
        .toLowerCase(),
      target
    })
  }

  return rows
}
