import { useAppStore, type AppState } from '@/store'
import { ensureDetectedAgentsForRepo } from './agent-detection-target-inventory'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { isTuiAgent } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ProjectLaunchContext } from '../../../shared/rpc-contract/preflight-params'
import type { AgentLaunchRequestId } from './agent-launch-request-id'
import {
  awaitStructuredRouteHostAnswer,
  planAgentSessionLaunch,
  type AgentSessionLaunchRequest
} from './agent-session-launch-plan'
import { getDefaultSetupDecision, getSetupConfig } from '../../../shared/orca-hook-setup-config'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { resolveGitHubPrStartPointForRepo } from '@/lib/github-pr-start-point'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { Repo } from '../../../shared/repo-types'
import type { OrcaHooks, RepoHookSettings } from '../../../shared/orca-yaml-hook-types'
import type { SetupDecision } from '../../../shared/worktree/create-types'
import type { GitHubPrStartPoint } from '../../../shared/worktree/types'
import type { LaunchWorkItemDirectArgs } from './launch-work-item-direct-types'

export async function resolveDirectPrStartPoint(
  repoId: string,
  prNumber: number,
  target: RuntimeClientTarget | null,
  hints: {
    branchName?: string
    headRefName?: string
    baseRefName?: string
    isCrossRepository?: boolean
  } = {}
): Promise<GitHubPrStartPoint> {
  return resolveGitHubPrStartPointForRepo({
    repoId,
    prNumber,
    target,
    headRefName: hints.headRefName ?? hints.branchName,
    baseRefName: hints.baseRefName,
    isCrossRepository: hints.isCrossRepository
  })
}

export async function resolveDirectSetupDecision(
  repoId: string,
  repo: { hookSettings?: RepoHookSettings },
  ownerHostId: ExecutionHostId
): Promise<{ kind: 'decided'; decision: SetupDecision } | { kind: 'needs-modal' }> {
  let yamlHooks: OrcaHooks | null = null
  try {
    // Why: the same owner host as the PR start point and createWorktree, never focus.
    const result = await checkRuntimeHooks(ownerHostId, repoId)
    yamlHooks = (result.hooks as OrcaHooks | null) ?? null
  } catch {
    yamlHooks = null
  }
  const setupConfig = getSetupConfig(repo, yamlHooks)
  if (!setupConfig) {
    // No configured setup means no setup decision, matching callers that omit it.
    return { kind: 'decided', decision: 'inherit' }
  }
  const decision = getDefaultSetupDecision(
    true,
    repo.hookSettings?.setupRunPolicy ?? 'run-by-default'
  )
  return decision ? { kind: 'decided', decision } : { kind: 'needs-modal' }
}

export type DirectLaunchOwnerRow = {
  repo: Repo
  executionHostId: ExecutionHostId
  target: RuntimeClientTarget
}

/** Share one repo owner across setup, PR start, trust and creation; null/ambiguous owner goes to the modal rather than focus-based guessing. */
export function resolveDirectLaunchOwnerRow(
  repos: readonly Repo[],
  repoId: string
): DirectLaunchOwnerRow | null {
  const rows = repos.filter((r) => r.id === repoId)
  if (rows.length !== 1) {
    return null
  }
  const executionHostId = getRepoExecutionHostId(rows[0])
  const target = ipcOrRuntimeTargetForHostId(executionHostId)
  return target ? { repo: rows[0], executionHostId, target } : null
}

/** Freeze the prospective verdict before create; the actual-agent path handles older hosts. */
export async function planDirectWorkItemLaunch(args: {
  requestId: AgentLaunchRequestId
  prospectiveAgent: TuiAgent | null
  projectContext?: ProjectLaunchContext
  repoId: string
  repoOwnerHostId: ExecutionHostId
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  resolveSessionOptions?: (agent: TuiAgent) => Readonly<Record<string, string>> | undefined
  sessionOptions?: Readonly<Record<string, string>>
  launchChoice?: LaunchWorkItemDirectArgs['launchChoice']
}) {
  const { prospectiveAgent, projectContext } = args
  if (!prospectiveAgent) {
    return undefined
  }
  const sessionOptions = args.resolveSessionOptions
    ? args.resolveSessionOptions(prospectiveAgent)
    : args.sessionOptions
  const request: AgentSessionLaunchRequest = {
    requestId: args.requestId,
    agent: prospectiveAgent,
    workspace: {
      kind: projectContext?.workspaceKind ?? 'git-worktree',
      repoId: args.repoId,
      executionHostId: args.repoOwnerHostId,
      ...(projectContext ? { executionContext: projectContext.executionContext } : {})
    },
    prompt: args.draftContent,
    promptDelivery: args.promptDelivery,
    ...(sessionOptions ? { launchOptions: sessionOptions } : {}),
    ...directLaunchSurfaceRequest(args.launchChoice)
  }
  await awaitStructuredRouteHostAnswer(useAppStore.getState(), request, 3000)
  return planAgentSessionLaunch(useAppStore.getState(), request)
}

/** A picked surface stays explicit through both planning sites; none follows the settings route. */
export function directLaunchSurfaceRequest(
  choice: LaunchWorkItemDirectArgs['launchChoice']
): Pick<AgentSessionLaunchRequest, 'requestedSurface' | 'selectedExecutionHostId'> {
  return {
    ...(choice?.requestedSurface ? { requestedSurface: choice.requestedSurface } : {}),
    ...(choice?.executionHostId ? { selectedExecutionHostId: choice.executionHostId } : {})
  }
}

export async function resolveDirectProspectiveAgent(
  store: AppState,
  repo: Repo,
  projectContext: ProjectLaunchContext | undefined,
  args: Pick<LaunchWorkItemDirectArgs, 'agentOverride' | 'agentLaunchPreferences'>
) {
  const { agentOverride, agentLaunchPreferences } = args
  const detectedAgentsPromise = projectContext
    ? Promise.resolve(projectContext.agents)
    : agentOverride
      ? null
      : ensureDetectedAgentsForRepo(store, repo)
  const preferences = agentLaunchPreferences ?? store.settings
  const prospectiveAgent =
    agentOverride ??
    pickTuiAgent(
      preferences?.defaultTuiAgent,
      new Set(((await detectedAgentsPromise) ?? []).filter(isTuiAgent)),
      preferences?.disabledTuiAgents
    )
  const unavailable = Boolean(
    agentLaunchPreferences &&
    agentOverride &&
    !isTuiAgentEnabled(agentOverride, agentLaunchPreferences.disabledTuiAgents)
  )
  return { detectedAgentsPromise, prospectiveAgent, unavailable }
}
