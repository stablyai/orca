import { toast } from 'sonner'
import { useAppStore } from '@/store'
import {
  resolveQualifiedIndexedFolderWorkspace,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'
import {
  findIndexedProjectGroupOwner,
  findIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import { ensureDetectedAgentsForTarget } from '@/lib/agent-detection-target-inventory'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { submitFolderWorkspaceCreate } from './workspace-creation/folder/folder-workspace-composer-submit'
import { getFolderWorkspaceAgentLaunchFact } from './workspace-creation/folder/folder-workspace-agent-startup'
import {
  beginDirectFolderCreate,
  directCreateAgentFailure,
  directCreateDetectionTarget,
  isDirectCreateCancelled,
  resolveDirectCreateAgent
} from './folder-workspace-default-agent'
import { startFolderRepoWorkspace } from './folder-repo-direct-create'
import {
  getHeaderCreateWorkspaceTarget,
  openHeaderCreateComposer
} from './worktree-list/rows/header-create-workspace-target'

type FolderCreateSource = {
  folderPath?: string
  executionHostId: ExecutionHostId
  connectionId: string | null
  runtimeEnvironmentId: string | null
}

export type CurrentWorkspaceCreate =
  | { kind: 'started' }
  | {
      kind: 'composer'
      initialRepoId: string
      initialWorkspaceTarget?: WorkspaceCreationTargetHint
    }
  | { kind: 'unavailable' }

function runtimeEnvironmentIdOf(executionHostId: string | null | undefined): string | null {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'runtime' ? host.environmentId : null
}

function projectGroupForWorkspace(
  projectGroups: readonly ProjectGroup[],
  projectGroupId: string,
  hostId: ExecutionHostId
): ProjectGroup | null {
  return (
    findIndexedProjectGroupOwner(projectGroups, projectGroupId, hostId) ??
    findIndexedProjectGroupOwner(projectGroups, projectGroupId)
  )
}

export async function createFolderWorkspaceFromSidebar(
  projectGroup: ProjectGroup,
  source?: FolderCreateSource
): Promise<void> {
  if (!projectGroup.parentPath) {
    return
  }
  beginDirectFolderCreate()
  const { createFolderWorkspace, settings } = useAppStore.getState()
  const runtimeEnvironmentId = source
    ? source.runtimeEnvironmentId
    : runtimeEnvironmentIdOf(projectGroup.executionHostId)
  // The resolved source's host owns the agent launch as well as the create.
  const launchGroup = source
    ? {
        ...projectGroup,
        executionHostId: source.executionHostId,
        connectionId: source.connectionId
      }
    : projectGroup
  const executionHostId = getNewWorkspaceProjectGroupHostId(launchGroup)
  let agent: TuiAgent | null = null
  let createStarted = false
  try {
    const resolved = await resolveDirectCreateAgent(
      { kind: 'folder', runtimeEnvironmentId, executionHostId },
      () =>
        ensureDetectedAgentsForTarget(
          useAppStore.getState(),
          directCreateDetectionTarget(executionHostId)
        )
    )
    agent = resolved.agent
    await submitFolderWorkspaceCreate({
      projectGroup: launchGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: agent,
      autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
      settings: settings ?? undefined,
      agentLaunchPreferences: resolved.preferences,
      agentCmdOverrides: settings?.agentCmdOverrides,
      terminalWindowsShell: settings?.terminalWindowsShell,
      runtimeEnvironmentId,
      ...(source?.folderPath ? { folderPath: source.folderPath } : {}),
      ...(source ? { connectionId: source.connectionId } : {}),
      createFolderWorkspace: (input) => {
        createStarted = true
        return createFolderWorkspace(input, { runtimeEnvironmentId })
      },
      onOpenChange: () => {}
    })
  } catch (error) {
    if (isDirectCreateCancelled(error)) {
      return
    }
    toast.error(
      agent && !createStarted
        ? directCreateAgentFailure(
            agent,
            getFolderWorkspaceAgentLaunchFact(useAppStore.getState(), launchGroup)
          )
        : getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error))
    )
  }
}

export function createWorkspaceForRepoHeader(repo: Repo, options: { pinHost: boolean }): void {
  if (isFolderRepo(repo)) {
    void startFolderRepoWorkspace(repo)
    return
  }
  openHeaderCreateComposer(repo, options)
}

function repoForWorktree(
  repos: readonly Repo[],
  repoId: string,
  hostId: ExecutionHostId | undefined
): Repo | undefined {
  const matches = repos.filter((repo) => repo.id === repoId)
  if (hostId) {
    // A missing host match must not become another host's checkout. The dialog hint is built from this repo.
    return matches.find((repo) => getRepoExecutionHostId(repo) === hostId)
  }
  return matches.length === 1 ? matches[0] : undefined
}

export function startCreateFromCurrentWorkspace(): CurrentWorkspaceCreate {
  const state = useAppStore.getState()
  const scope = state.activeWorkspaceKey ? parseWorkspaceKey(state.activeWorkspaceKey) : null
  if (scope?.type === 'folder') {
    const result = resolveQualifiedIndexedFolderWorkspace(
      state,
      scope.folderWorkspaceId,
      state.activeWorkspaceExecutionHostId ?? undefined
    )
    if (result.kind !== 'selected') {
      return { kind: 'unavailable' }
    }
    const group = projectGroupForWorkspace(
      state.projectGroups,
      result.value.workspace.projectGroupId,
      result.value.hostId
    )
    if (!group?.parentPath) {
      return { kind: 'unavailable' }
    }
    const host = parseExecutionHostId(result.value.hostId)
    void createFolderWorkspaceFromSidebar(group, {
      ...(result.value.workspace.folderPath
        ? { folderPath: result.value.workspace.folderPath }
        : {}),
      executionHostId: result.value.hostId,
      connectionId: result.value.connectionId,
      runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null
    })
    return { kind: 'started' }
  }

  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : state.activeWorktreeId
  if (!worktreeId) {
    return { kind: 'unavailable' }
  }
  const worktree = findIndexedWorktreeOwner(selectWorktreesByRepo(state), worktreeId)
  if (!worktree) {
    return { kind: 'unavailable' }
  }
  const repo = repoForWorktree(
    state.repos,
    worktree.repoId,
    state.activeWorkspaceExecutionHostId ?? undefined
  )
  if (!repo) {
    return { kind: 'unavailable' }
  }
  if (isFolderRepo(repo)) {
    void startFolderRepoWorkspace(repo)
    return { kind: 'started' }
  }
  return {
    kind: 'composer',
    initialRepoId: repo.id,
    ...getHeaderCreateWorkspaceTarget(repo, state.repos, state.projectHostSetups ?? [])
  }
}
