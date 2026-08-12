import type { useAppStore } from '@/store'
import {
  buildAgentDraftLaunchPlan,
  buildAgentSessionRulesPrompt,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '@/lib/tui-agent-startup'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { pickQuickWorkspaceAgent } from '@/lib/quick-workspace-agent-selection'
import type {
  PendingWorktreeCreation,
  WorktreeCreationRequest
} from '@/lib/pending-worktree-creation'
import { CLIENT_PLATFORM, getWorkspaceIntentName, getWorkspaceSeedName } from '@/lib/new-workspace'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import { resolveGitHubWorkItemIdentity } from '@/lib/github-work-item-identity'
import { buildGitHubWorkspaceSource } from '../../../shared/new-workspace/workspace-source'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import type { GitHubWorkItem, GlobalSettings, Repo, TuiAgent } from '../../../shared/types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../../shared/task-source-context'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

export type GitHubWorkItemBackgroundStoreSnapshot = {
  repos: readonly Repo[]
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  sshConnectionStates: ReturnType<typeof useAppStore.getState>['sshConnectionStates']
  runtimeStatusByEnvironmentId: ReturnType<
    typeof useAppStore.getState
  >['runtimeStatusByEnvironmentId']
  settings:
    | Partial<
        Pick<
          GlobalSettings,
          | 'activeRuntimeEnvironmentId'
          | 'defaultTuiAgent'
          | 'disabledTuiAgents'
          | 'agentCmdOverrides'
          | 'agentDefaultArgs'
          | 'agentDefaultEnv'
          | 'terminalWindowsShell'
        >
      >
    | null
    | undefined
  ensureDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureDetectedAgents']
  ensureRemoteDetectedAgents: ReturnType<typeof useAppStore.getState>['ensureRemoteDetectedAgents']
  ensureRuntimeDetectedAgents: ReturnType<
    typeof useAppStore.getState
  >['ensureRuntimeDetectedAgents']
}

export type BuildInitialGitHubWorkItemRequestArgs = {
  item: GitHubWorkItem
  repoId: string
  taskSourceContext?: TaskSourceContext | null
  workspaceRunContext?: WorkspaceRunContext | null
  telemetrySource?: WorktreeCreationRequest['telemetrySource']
}

function resolveGitHubWorkItemPrompt(
  item: GitHubWorkItem
): ReturnType<typeof resolveQuickCreateLinkedWorkItemPrompt> {
  return resolveQuickCreateLinkedWorkItemPrompt(item, '')
}

export function buildGitHubWorkItemBackendStartup(
  agent: TuiAgent | null,
  startupPlan: AgentStartupPlan | null,
  quickTelemetry: AgentStartedTelemetry | null
): WorktreeCreationRequest['startup'] {
  if (!agent || !startupPlan || startupPlan.draftPrompt || startupPlan.followupPrompt) {
    return undefined
  }
  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    ...(quickTelemetry ? { telemetry: quickTelemetry } : {})
  }
}

function getWorkspaceRunContextForRepo(
  repo: Repo,
  provided: WorkspaceRunContext | null | undefined
): WorkspaceRunContext | null {
  if (provided) {
    return provided
  }
  const projection = projectHostSetupProjectionFromRepos([repo])
  const project = projection.projects[0]
  const setup = projection.setups[0]
  if (!project || !setup) {
    return null
  }
  return {
    kind: 'workspace-run',
    projectId: project.id,
    hostId: getRepoExecutionHostId(repo),
    projectHostSetupId: setup.id,
    repoId: repo.id,
    path: repo.path
  }
}

export async function resolvePreferredQuickAgentForGitHubWorkItem(
  store: GitHubWorkItemBackgroundStoreSnapshot,
  repo: Repo
): Promise<TuiAgent | null> {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  const detectedAgents =
    host?.kind === 'ssh'
      ? await store.ensureRemoteDetectedAgents(host.targetId)
      : host?.kind === 'runtime'
        ? await store.ensureRuntimeDetectedAgents(host.environmentId)
        : await store.ensureDetectedAgents()
  return pickQuickWorkspaceAgent(
    store.settings?.defaultTuiAgent,
    detectedAgents,
    store.settings?.disabledTuiAgents
  )
}

function resolveGitHubWorkItemLaunchPlatform(
  store: GitHubWorkItemBackgroundStoreSnapshot,
  repo: Repo
): NodeJS.Platform {
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  if (host?.kind === 'runtime') {
    return (
      store.runtimeStatusByEnvironmentId.get(host.environmentId)?.status?.hostPlatform ?? 'linux'
    )
  }
  const projectRuntime = repo.connectionId
    ? undefined
    : getLocalRepoProjectExecutionRuntimeContext(
        store as ReturnType<typeof useAppStore.getState>,
        repo.id,
        CLIENT_PLATFORM
      )
  return resolveSourceControlLaunchPlatform({
    connectionId: repo.connectionId,
    worktreePath: repo.path,
    projectRuntime
  })
}

export function buildGitHubWorkItemStartupPlan(args: {
  agent: TuiAgent | null
  item: GitHubWorkItem
  repo: Repo
  store: GitHubWorkItemBackgroundStoreSnapshot
}): {
  startupPlan: AgentStartupPlan | null
  quickPrompt: string
  /** Draft context (issue link) that reaches only the TUI input; callers thread
   *  it onto the creation request so completion can seed the chat composer. */
  launchDraftPrompt: string | null
  quickTelemetry: AgentStartedTelemetry | null
} {
  const { agent, item, repo, store } = args
  if (!agent) {
    return { startupPlan: null, quickPrompt: '', launchDraftPrompt: null, quickTelemetry: null }
  }
  const { prompt: quickPrompt, draftPrompt } = resolveGitHubWorkItemPrompt(item)
  const platform = resolveGitHubWorkItemLaunchPlatform(store, repo)
  const isRemote = repoIsRemote(repo)
  const shell = resolveLocalWindowsAgentStartupShell({
    platform,
    isRemote,
    terminalWindowsShell: store.settings?.terminalWindowsShell
  })
  const draftLaunchPlan = draftPrompt
    ? buildAgentDraftLaunchPlan({
        agent,
        draft: draftPrompt,
        cmdOverrides: store.settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
        platform,
        shell,
        isRemote,
        repoId: repo.id,
        connectionId: repo.connectionId,
        executionHostId: getRepoExecutionHostId(repo)
      })
    : null
  const startupPlan = draftLaunchPlan
    ? {
        agent: draftLaunchPlan.agent,
        launchCommand: draftLaunchPlan.launchCommand,
        expectedProcess: draftLaunchPlan.expectedProcess,
        followupPrompt: null,
        launchConfig: draftLaunchPlan.launchConfig,
        ...(draftLaunchPlan.startupCommandDelivery
          ? { startupCommandDelivery: draftLaunchPlan.startupCommandDelivery }
          : {}),
        ...(draftLaunchPlan.env ? { env: draftLaunchPlan.env } : {})
      }
    : buildAgentStartupPlan({
        agent,
        prompt: quickPrompt,
        cmdOverrides: store.settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
        platform,
        shell,
        isRemote,
        allowEmptyPromptLaunch: true,
        repoId: repo.id,
        connectionId: repo.connectionId,
        executionHostId: getRepoExecutionHostId(repo)
      })
  if (startupPlan && draftPrompt && !draftLaunchPlan) {
    startupPlan.draftPrompt = buildAgentSessionRulesPrompt({
      agent,
      prompt: draftPrompt,
      repoId: repo.id,
      connectionId: repo.connectionId,
      executionHostId: getRepoExecutionHostId(repo)
    })
  }
  return {
    startupPlan,
    quickPrompt,
    launchDraftPrompt: draftPrompt || null,
    quickTelemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: 'new_workspace_composer',
      request_kind: 'new'
    }
  }
}

function getGitHubWorkItemName(item: GitHubWorkItem): { seedName: string; displayName?: string } {
  const identity = resolveGitHubWorkItemIdentity(item)
  const intent =
    identity.number !== null
      ? getWorkspaceIntentName({
          sourceText: item.title,
          workItem: { type: identity.type, number: identity.number, title: item.title }
        })
      : null
  return {
    seedName: getWorkspaceSeedName({
      explicitName: intent?.seedName ?? '',
      prompt: '',
      linkedIssueNumber: identity.type === 'issue' ? identity.number : null,
      linkedPR: identity.type === 'pr' ? identity.number : null
    }),
    ...(intent?.displayName ? { displayName: intent.displayName } : {})
  }
}

export function buildInitialGitHubWorkItemRequest(
  args: BuildInitialGitHubWorkItemRequestArgs,
  repo: Repo
): WorktreeCreationRequest {
  const { seedName, displayName } = getGitHubWorkItemName(args.item)
  const workspaceRunContext = getWorkspaceRunContextForRepo(repo, args.workspaceRunContext)
  const ownerHost = parseExecutionHostId(getRepoExecutionHostId(repo))
  const identity = resolveGitHubWorkItemIdentity(args.item)
  const linkedWorkItem =
    identity.number !== null
      ? buildGitHubWorkspaceSource({
          type: identity.type,
          number: identity.number,
          title: args.item.title,
          url: args.item.url,
          repoId: args.repoId
        })
      : null
  return {
    repoId: args.repoId,
    worktreeCreateProgressMode: ownerHost?.kind === 'local' ? 'stepped' : 'indeterminate',
    ...(args.taskSourceContext ? { taskSourceContext: args.taskSourceContext } : {}),
    ...(linkedWorkItem
      ? {
          linkedWorkItem,
          ...(args.taskSourceContext ? { linkedTaskSourceContext: args.taskSourceContext } : {})
        }
      : {}),
    ...(workspaceRunContext ? { workspaceRunContext } : {}),
    name: seedName,
    ...(displayName ? { displayName } : {}),
    ...(identity.type === 'issue' && identity.number ? { linkedIssue: identity.number } : {}),
    ...(identity.type === 'pr' && identity.number ? { linkedPR: identity.number } : {}),
    ...(args.telemetrySource ? { telemetrySource: args.telemetrySource } : {}),
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
}
