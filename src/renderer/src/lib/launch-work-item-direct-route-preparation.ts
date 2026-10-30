import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import type { RepoHostFields } from '@/lib/agent-detection-target-inventory'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  refineLocalLaunchPlatform,
  resolveRepoExecutionHostPlatform,
  type KnownExecutionHostPlatform
} from '@/lib/execution-host-facts'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../shared/local-windows-terminal-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import type {
  AgentSessionLaunchPlan,
  planAgentSessionLaunch
} from '@/lib/agent-session-launch-plan'
import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import { directLaunchSurfaceRequest } from './launch-work-item-direct-preflight'
import type { LaunchWorkItemDirectArgs } from './launch-work-item-direct-types'
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  buildDirectWorkItemStartup,
  resolveDirectWorkItemAgent
} from '@/lib/launch-work-item-direct-agent-routing'

export type DirectWorkItemAgentLaunchPreparation = {
  launchConnectionId: string | null
  unavailable: boolean
  effectiveAgent: TuiAgent | null
  agentArgs?: string | null
  startupPlan: ReturnType<typeof buildDirectWorkItemStartup>['startupPlan']
  draftLaunchedNatively: boolean
  startupPlanFailed: boolean
  structuredLaunch: boolean
  plan: AgentSessionLaunchPlan | null
}

type DirectLaunchHostArgs = {
  latestStore: AppState
  worktreeId: string
  worktreePath: string
  repoHost: RepoHostFields & { path: string }
  launchPlatform?: NodeJS.Platform
  repoLaunchHost: KnownExecutionHostPlatform
  repoProjectRuntime?: ProjectExecutionRuntimeResolution
}

function directLaunchProjectRuntime(
  args: DirectLaunchHostArgs
): ProjectExecutionRuntimeResolution | undefined {
  return (
    getLocalProjectExecutionRuntimeContext(args.latestStore, args.worktreeId, CLIENT_PLATFORM) ??
    args.repoProjectRuntime
  )
}

function resolveDirectWorkItemLaunchHost(args: DirectLaunchHostArgs): KnownExecutionHostPlatform {
  // Use the creation repo’s host before workspace hydration, refined by its path/runtime (for example Windows-host WSL runs Linux).
  const fact = resolveRepoExecutionHostPlatform(
    args.latestStore,
    args.repoHost,
    () => directLaunchProjectRuntime(args),
    args.worktreePath
  )
  return refineLocalLaunchPlatform(
    fact.kind === 'known' ? fact : args.repoLaunchHost,
    args.launchPlatform
  )
}

/** The shell the local tab actually spawns, which a project runtime can override (e.g. WSL setting, Windows runtime). */
function resolveDirectWorkItemTabShell(args: DirectLaunchHostArgs): string | undefined {
  return resolveLocalWindowsTerminalShellOverrideForTab({
    explicitShellOverride: undefined,
    defaultWindowsShell: args.latestStore.settings?.terminalWindowsShell ?? undefined,
    isWslWorktree: isWslUncPath(args.worktreePath),
    projectRuntime: directLaunchProjectRuntime(args)
  })
}

export async function prepareDirectWorkItemAgentLaunch(args: {
  worktreeId: string
  worktreePath: string
  repoId: string
  agentLaunchPreferences?: LaunchWorkItemDirectArgs['agentLaunchPreferences']
  agentOverride?: TuiAgent
  agentArgs?: string | null
  sessionOptions?: Readonly<Record<string, string>>
  resolveAgentArgs?: (agent: TuiAgent) => string | null | undefined
  resolveSessionOptions?: (agent: TuiAgent) => Readonly<Record<string, string>> | undefined
  launchChoice?: LaunchWorkItemDirectArgs['launchChoice']
  sessionOptionsYieldToAgentArgs?: true
  repoConnectionId: string | null
  repoHost: RepoHostFields & { path: string }
  latestStore: AppState
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  /** Host the repo creates worktrees on; stands in while the new worktree is not hydrated. */
  repoLaunchHost: KnownExecutionHostPlatform
  repoProjectRuntime?: ProjectExecutionRuntimeResolution
  planLaunch: typeof planAgentSessionLaunch
  requestId: AgentLaunchRequestId
  preflightPlan?: AgentSessionLaunchPlan
}): Promise<DirectWorkItemAgentLaunchPreparation> {
  const agentSelection = await resolveDirectWorkItemAgent({
    agentOverride: args.agentOverride,
    agentLaunchPreferences: args.agentLaunchPreferences,
    worktreeId: args.worktreeId,
    repoHost: args.repoHost,
    latestStore: args.latestStore
  })
  const latestStore = agentSelection.store
  const launchConnectionId =
    getConnectionIdFromState(latestStore, args.worktreeId) ?? args.repoConnectionId
  const hostArgs = { ...args, latestStore }
  if (agentSelection.unavailable) {
    return {
      launchConnectionId,
      unavailable: true,
      effectiveAgent: null,
      startupPlan: null,
      draftLaunchedNatively: false,
      startupPlanFailed: false,
      structuredLaunch: false,
      plan: null
    }
  }

  const effectiveAgent = agentSelection.agent
  if (effectiveAgent) {
    // Persist the choice so ownership and removal safety see the selected agent.
    void latestStore
      .updateWorktreeMeta(args.worktreeId, { createdWithAgent: effectiveAgent })
      .catch(() => {
        // Non-critical: activation still has the explicit startup below.
      })
  }
  const agentArgs =
    effectiveAgent && args.resolveAgentArgs ? args.resolveAgentArgs(effectiveAgent) : args.agentArgs
  const sessionOptions = effectiveAgent
    ? args.resolveSessionOptions
      ? args.resolveSessionOptions(effectiveAgent)
      : args.sessionOptions
    : undefined
  const plan =
    effectiveAgent === null
      ? null
      : args.preflightPlan?.agent === effectiveAgent
        ? adoptAgentSessionLaunchVerdict({ ...args.preflightPlan, worktreeId: args.worktreeId })
        : args.planLaunch(latestStore, {
            requestId: args.requestId,
            agent: effectiveAgent,
            workspace: { kind: 'git-worktree', worktreeId: args.worktreeId, repoId: args.repoId },
            prompt: args.draftContent,
            promptDelivery: args.promptDelivery,
            ...(sessionOptions ? { launchOptions: sessionOptions } : {}),
            ...directLaunchSurfaceRequest(args.launchChoice)
          })
  const structuredLaunch = plan?.route === 'structured-native-chat'

  const { startupPlan, draftLaunchedNatively, startupPlanFailed } = structuredLaunch
    ? { startupPlan: null, draftLaunchedNatively: false, startupPlanFailed: false }
    : buildDirectWorkItemStartup({
        agent: effectiveAgent,
        agentArgs,
        sessionOptions,
        sessionOptionsYieldToAgentArgs: args.sessionOptionsYieldToAgentArgs,
        draftContent: args.draftContent,
        promptDelivery: args.promptDelivery,
        settings: latestStore.settings,
        launchHost: resolveDirectWorkItemLaunchHost(hostArgs),
        terminalWindowsShell: resolveDirectWorkItemTabShell(hostArgs),
        launchConnectionId
      })

  return {
    launchConnectionId,
    unavailable: false,
    effectiveAgent,
    agentArgs,
    startupPlan,
    draftLaunchedNatively,
    startupPlanFailed,
    structuredLaunch,
    plan
  }
}
