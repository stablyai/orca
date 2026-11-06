import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  formatWorkspaceCreateError,
  getWorkspaceCreateErrorToastMessage
} from '@/lib/workspace-create-error-format'
import { runBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import { resolveAgentSessionLaunchRoute } from '@/lib/agent-session-launch-plan'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveExecutionHostAgentStartupShell,
  resolveRepoExecutionHostPlatform,
  type ExecutionHostPlatformFact
} from '@/lib/execution-host-facts'
import { prepareQuickComposerStartup } from '@/hooks/composer-state/quick-startup-plan'
import { buildQuickCreationRequest } from '@/hooks/composer-state/quick-creation-request'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { repoIsRemote } from '../../../../shared/agent-launch/startup/agent-launch-remote'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { Repo } from '../../../../shared/repo-types'
import { getSuggestedCreatureName } from './workspace-creation/naming/worktree-name-suggestions'
import {
  beginDirectFolderCreate,
  detectFolderRepoAgents,
  directCreateAgentFailure,
  isDirectCreateCancelled,
  resolveDirectCreateAgent
} from './folder-workspace-default-agent'

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

export async function startFolderRepoWorkspace(repo: Repo): Promise<void> {
  beginDirectFolderCreate()
  const executionHostId = getRepoExecutionHostId(repo)
  const name = getSuggestedCreatureName(selectWorktreesByRepo(useAppStore.getState()))
  const workspace = { kind: 'folder', repoId: repo.id, executionHostId } as const
  let agent: TuiAgent | null = null
  try {
    const resolved = await resolveDirectCreateAgent(
      workspace,
      detectFolderRepoAgents(repo.id, executionHostId)
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
