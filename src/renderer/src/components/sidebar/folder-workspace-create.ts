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
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'
import { getAgentLabel } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getNewWorkspaceProjectGroupHostId } from '@/lib/new-workspace-project-options'
import {
  resolveExecutionHostAgentStartupShell,
  resolveRepoExecutionHostPlatform,
  type ExecutionHostPlatformFact
} from '@/lib/execution-host-facts'
import { prepareQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
import { buildQuickCreationRequest } from '@/hooks/composer-state/quick-creation-request'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { repoIsRemote } from '../../../../shared/agent-launch/startup/agent-launch-remote'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Repo } from '../../../../shared/repo-types'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { getSuggestedCreatureName } from './workspace-creation/naming/worktree-name-suggestions'
import { completeAgentSessionsParallelStep } from '../contextual-tours/workspace-creation-tour-handoff'
import { submitFolderWorkspaceCreate } from './workspace-creation/folder/folder-workspace-composer-submit'
import { getFolderWorkspaceAgentLaunchFact } from './workspace-creation/folder/folder-workspace-agent-startup'
import {
  directCreateDetectionTarget,
  isDirectCreateCancelled,
  resolveDirectCreateAgent
} from './folder-workspace-default-agent'
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

// A direct create replaces the composer, whose opening is what cleared the final + tip on every create entry point.
function beginDirectFolderCreate(): void {
  completeAgentSessionsParallelStep()
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

// A direct create refuses where the dialog's Create would, but with no dialog open the message names where to fix it.
function directCreateAgentFailure(agent: TuiAgent, launchHost: ExecutionHostPlatformFact): string {
  const label = getAgentLabel(agent)
  return launchHost.kind === 'withheld'
    ? translate(
        'auto.components.sidebar.folderWorkspaceCreate.agentHostUnknown',
        'Could not start {{agent}}. {{reason}}',
        { agent: label, reason: launchHost.reason }
      )
    : translate(
        'auto.components.sidebar.folderWorkspaceCreate.agentStartFailed',
        'Could not start {{agent}}. Check its Arguments in Settings → Agents, then try again.',
        { agent: label }
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
      directCreateDetectionTarget(executionHostId)
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

function repoAgentLaunchFact(repo: Repo): ExecutionHostPlatformFact {
  const state = useAppStore.getState()
  // Quote for the repo host's OS, as the dialog does (#22204).
  return resolveRepoExecutionHostPlatform(state, repo, () =>
    getLocalRepoProjectExecutionRuntimeContext(
      { ...state, activeWorktreeId: null, worktreesByRepo: selectWorktreesByRepo(state) },
      repo.id,
      CLIENT_PLATFORM
    )
  )
}

async function startFolderRepoWorkspace(repo: Repo): Promise<void> {
  beginDirectFolderCreate()
  const executionHostId = getRepoExecutionHostId(repo)
  const name = getSuggestedCreatureName(selectWorktreesByRepo(useAppStore.getState()))
  const workspace = { kind: 'folder', repoId: repo.id, executionHostId } as const
  let agent: TuiAgent | null = null
  try {
    const resolved = await resolveDirectCreateAgent(
      workspace,
      directCreateDetectionTarget(executionHostId)
    )
    agent = resolved.agent
    const state = useAppStore.getState()
    const launchHost = repoAgentLaunchFact(repo)
    const route = agent
      ? resolveAgentSessionLaunchRoute(state, {
          agent,
          workspace,
          prompt: '',
          promptDelivery: 'auto-submit'
        })
      : 'terminal-tui'
    const startup = await prepareQuickComposerStartup({
      agent,
      linkedWorkItem: null,
      note: '',
      repoId: repo.id,
      executionHostId,
      settings: state.settings,
      launchHost,
      shell: resolveExecutionHostAgentStartupShell(
        launchHost,
        state.settings?.terminalWindowsShell
      ),
      isRemote: repoIsRemote(repo),
      telemetrySource: 'sidebar',
      route,
      preferences: resolved.preferences
    })
    runBackgroundWorktreeCreation({
      ...buildQuickCreationRequest({
        repoId: repo.id,
        ephemeralVmRecipe: undefined,
        indeterminateProgress: parseExecutionHostId(executionHostId)?.kind === 'runtime',
        taskSourceContext: null,
        linkedWorkItem: null,
        workspaceRunContext: undefined,
        workspaceName: name,
        nameWasGenerated: true,
        displayName: undefined,
        selectedRepoIsGit: false,
        baseBranch: undefined,
        compareBaseRef: undefined,
        setupDecision: 'skip',
        sparseDirectories: null,
        sparsePresetId: null,
        telemetrySource: 'sidebar',
        linkedIssue: null,
        linkedPR: null,
        pushTarget: undefined,
        agent,
        agentLaunchRoute: route,
        linkedLinearIssue: undefined,
        linkedLinearIssueWorkspaceId: undefined,
        linkedLinearIssueOrganizationUrlKey: undefined,
        branchNameOverride: undefined,
        parentWorktreeId: null,
        workspaceStatus: undefined,
        linkedGitLabMR: null,
        linkedGitLabIssue: null,
        includeGitLabLinks: false,
        // Structured Chat starts its own session; a terminal startup would launch the agent twice.
        startup: route === 'structured-native-chat' ? undefined : startup.backendStartup,
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: startup.startupPlan,
        quickPrompt: startup.prompt,
        launchDraftPrompt: startup.draftPrompt,
        promptDelivery: 'auto-submit',
        quickTelemetry: startup.telemetry,
        suppressTerminalFocusOnCompletion: false,
        setupOnly: false
      }),
      executionHostId
    })
  } catch (error) {
    if (isDirectCreateCancelled(error)) {
      return
    }
    toast.error(
      agent
        ? directCreateAgentFailure(agent, repoAgentLaunchFact(repo))
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
