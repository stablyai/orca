import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { getConnectionId } from '@/lib/connection-context'
import { CLIENT_PLATFORM } from '@/lib/client-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type {
  AgentSessionLaunchPlan,
  planAgentSessionLaunch
} from '@/lib/agent-session-launch-plan'
import {
  buildDirectWorkItemStartup,
  markDirectWorkItemAgentTrusted,
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
  /** Null when no agent was selected. */
  plan: AgentSessionLaunchPlan | null
}

export async function prepareDirectWorkItemAgentLaunch(args: {
  worktreeId: string
  worktreePath: string
  repoId: string
  agentOverride?: TuiAgent
  agentArgs?: string | null
  repoConnectionId: string | null
  detectedAgentsPromise: Promise<string[]> | null
  latestStore: AppState
  settings: AppState['settings']
  draftContent: string
  promptDelivery: 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  repoProjectRuntime?: Parameters<typeof buildDirectWorkItemStartup>[0]['repoProjectRuntime']
  planLaunch: typeof planAgentSessionLaunch
}): Promise<DirectWorkItemAgentLaunchPreparation> {
  const launchConnectionId = getConnectionId(args.worktreeId) ?? args.repoConnectionId
  const agentSelection = await resolveDirectWorkItemAgent({
    agentOverride: args.agentOverride,
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
    launchPlatform: args.launchPlatform,
    launchConnectionId,
    worktreePath: args.worktreePath,
    repoProjectRuntime:
      launchConnectionId === null
        ? (getLocalProjectExecutionRuntimeContext(
            args.latestStore,
            args.worktreeId,
            CLIENT_PLATFORM
          ) ?? args.repoProjectRuntime)
        : undefined
  })

  const plan =
    effectiveAgent === null
      ? null
      : args.planLaunch(args.latestStore, {
          agent: effectiveAgent,
          workspace: { kind: 'git-worktree', worktreeId: args.worktreeId, repoId: args.repoId },
          prompt: args.draftContent,
          promptDelivery: args.promptDelivery,
          tuiCustomization: { agentArgs: args.agentArgs },
          initialSessionOptions: startupPlan?.sessionOptions
        })
  const structuredLaunch = plan?.route === 'structured-native-chat'

  await markDirectWorkItemAgentTrusted({
    structuredLaunch,
    agent: effectiveAgent,
    workspacePath: args.worktreePath,
    connectionId: args.repoConnectionId
  })

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
