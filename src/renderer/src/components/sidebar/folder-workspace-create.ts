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
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getSuggestedCreatureName } from './workspace-creation/naming/worktree-name-suggestions'
import { submitFolderWorkspaceCreate } from './workspace-creation/folder/folder-workspace-composer-submit'
import {
  getHeaderCreateWorkspaceTarget,
  openHeaderCreateComposer
} from './worktree-list/rows/header-create-workspace-target'

type FolderCreateSource = {
  folderPath?: string
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

function dismissCoveringModal(): void {
  const state = useAppStore.getState()
  if (state.activeModal && state.activeModal !== 'none') {
    state.closeModal()
  }
}

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
  dismissCoveringModal()
  const { createFolderWorkspace } = useAppStore.getState()
  const runtimeEnvironmentId = source
    ? source.runtimeEnvironmentId
    : runtimeEnvironmentIdOf(projectGroup.executionHostId)
  try {
    await submitFolderWorkspaceCreate({
      projectGroup,
      name: '',
      lastAutoName: '',
      linkedWorkItem: null,
      note: '',
      quickAgent: null,
      autoRenameBranchFromWork: undefined,
      agentCmdOverrides: undefined,
      runtimeEnvironmentId,
      ...(source?.folderPath ? { folderPath: source.folderPath } : {}),
      ...(source ? { connectionId: source.connectionId } : {}),
      createFolderWorkspace: (input) => createFolderWorkspace(input, { runtimeEnvironmentId }),
      onOpenChange: () => {}
    })
  } catch (error) {
    toast.error(getWorkspaceCreateErrorToastMessage(formatWorkspaceCreateError(error)))
  }
}

function directFolderProgressMode(repo: Repo): 'stepped' | 'indeterminate' {
  // The setup panel stays hidden only for an explicit stepped request, which is what an ordinary folder submit uses unless the repo is on an environment.
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'runtime' ? 'indeterminate' : 'stepped'
}

function startFolderRepoWorkspace(repo: Repo): void {
  dismissCoveringModal()
  const state = useAppStore.getState()
  runBackgroundWorktreeCreation({
    repoId: repo.id,
    executionHostId: getRepoExecutionHostId(repo),
    worktreeCreateProgressMode: directFolderProgressMode(repo),
    name: getSuggestedCreatureName(selectWorktreesByRepo(state)),
    nameWasGenerated: true,
    setupDecision: 'skip',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null,
    telemetrySource: 'sidebar'
  })
}

export function createWorkspaceForRepoHeader(repo: Repo, options: { pinHost: boolean }): void {
  if (isFolderRepo(repo)) {
    startFolderRepoWorkspace(repo)
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
    startFolderRepoWorkspace(repo)
    return { kind: 'started' }
  }
  return {
    kind: 'composer',
    initialRepoId: repo.id,
    ...getHeaderCreateWorkspaceTarget(repo, state.repos, state.projectHostSetups ?? [])
  }
}
