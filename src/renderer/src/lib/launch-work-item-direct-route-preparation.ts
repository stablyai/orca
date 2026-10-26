import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { getConnectionId } from '@/lib/connection-context'
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
import type { AgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import {
  buildDirectWorkItemStartup,
  resolveDirectWorkItemAgent
} from '@/lib/launch-work-item-direct-agent-routing'

export type DirectWorkItemAgentLaunchPreparation = {
  launchConnectionId: string | null
  unavailable: boolean
  effectiveAgent: TuiAgent | null
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
  agentOverride?: TuiAgent
  agentArgs?: string | null
  repoConnectionId: string | null
  repoHost: RepoHostFields & { path: string }
  detectedAgentsPromise: Promise<string[]> | null
  latestStore: AppState
  settings: AppState['settings']
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  /** Host the repo creates worktrees on; stands in while the new worktree is not hydrated. */
  repoLaunchHost: KnownExecutionHostPlatform
  repoProjectRuntime?: ProjectExecutionRuntimeResolution
  planLaunch: typeof planAgentSessionLaunch
  requestId: AgentLaunchRequestId
}): Promise<DirectWorkItemAgentLaunchPreparation> {
  const launchConnectionId = getConnectionId(args.worktreeId) ?? args.repoConnectionId
  const agentSelection = await resolveDirectWorkItemAgent({
    agentOverride: args.agentOverride,
    worktreeId: args.worktreeId,
    repoHost: args.repoHost,
    launchConnectionId,
    repoConnectionId: args.repoConnectionId,
    detectedAgentsPromise: args.detectedAgentsPromise,
    latestStore: args.latestStore
  })
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
    void args.latestStore
      .updateWorktreeMeta(args.worktreeId, { createdWithAgent: effectiveAgent })
      .catch(() => {
        // Non-critical: activation still has the explicit startup below.
      })
  }
  const { startupPlan, draftLaunchedNatively, startupPlanFailed } = buildDirectWorkItemStartup({
    agent: effectiveAgent,
    agentArgs: args.agentArgs,
    draftContent: args.draftContent,
    promptDelivery: args.promptDelivery,
    settings: args.settings,
    launchHost: resolveDirectWorkItemLaunchHost(args),
    terminalWindowsShell: resolveDirectWorkItemTabShell(args),
    launchConnectionId
  })

  const plan =
    effectiveAgent === null
      ? null
      : args.planLaunch(args.latestStore, {
          requestId: args.requestId,
          agent: effectiveAgent,
          workspace: { kind: 'git-worktree', worktreeId: args.worktreeId, repoId: args.repoId },
          prompt: args.draftContent,
          promptDelivery: args.promptDelivery
        })
  const structuredLaunch = plan?.route === 'structured-native-chat'

  return {
    launchConnectionId,
    unavailable: false,
    effectiveAgent,
    startupPlan,
    draftLaunchedNatively,
    startupPlanFailed,
    structuredLaunch,
    plan
  }
}
