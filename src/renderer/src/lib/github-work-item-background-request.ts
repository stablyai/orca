import type { useAppStore } from '@/store'
import {
  buildAgentDraftLaunchPlan,
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

type QuickCreateLinkedWorkItemPromptResult = ReturnType<
  typeof resolveQuickCreateLinkedWorkItemPrompt
>

function resolveGitHubWorkItemPrompt(item: GitHubWorkItem): QuickCreateLinkedWorkItemPromptResult {
  const resolver = resolveQuickCreateLinkedWorkItemPrompt as unknown as (
    linkedWorkItem: GitHubWorkItem,
    note: string,
    opts?: { cliAvailable: boolean }
  ) => QuickCreateLinkedWorkItemPromptResult
  return resolver(item, '', { cliAvailable: false })
}

export function buildGitHubWorkItemBackendStartup(
  agent: TuiAgent | null,
  startupPlan: AgentStartupPlan | null,
  quickTelemetry: AgentStartedTelemetry | null
): WorktreeCreationRequest['startup'] {
  // Why: draft/followup launches still need the renderer to finish terminal
  // setup, so only self-contained startup plans can move into createWorktree.
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
    // Why: the background runtime path gates on hostPlatform before this point;
    // POSIX is safer than client PowerShell if another caller violates that.
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
  quickTelemetry: AgentStartedTelemetry | null
} {
  const { agent, item, repo, store } = args
  if (!agent) {
    return { startupPlan: null, quickPrompt: '', quickTelemetry: null }
  }
  const { prompt: quickPrompt, draftPrompt } = resolveGitHubWorkItemPrompt(item)
  // Why: runtime-owned repos launch on their owner host, not on the client
  // desktop, so startup shell quoting must use the runtime platform.
  const platform = resolveGitHubWorkItemLaunchPlatform(store, repo)
  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only
  // `orca-ide` rename must not be applied for remote launches.
  const isRemote = repoIsRemote(repo)
  const draftLaunchPlan = draftPrompt
    ? buildAgentDraftLaunchPlan({
        agent,
        draft: draftPrompt,
        cmdOverrides: store.settings?.agentCmdOverrides ?? {},
        agentArgs: resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs),
        agentEnv: resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
        platform,
        isRemote
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
        isRemote,
        allowEmptyPromptLaunch: true
      })
  if (startupPlan && draftPrompt && !draftLaunchPlan) {
    startupPlan.draftPrompt = draftPrompt
  }
  return {
    startupPlan,
    quickPrompt,
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
  return {
    repoId: args.repoId,
    worktreeCreateProgressMode: ownerHost?.kind === 'local' ? 'stepped' : 'indeterminate',
    ...(args.taskSourceContext ? { taskSourceContext: args.taskSourceContext } : {}),
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
