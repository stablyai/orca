import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { getConnectionId } from '@/lib/connection-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { LaunchFile, UnstageableLine } from '../../../shared/launch-prompt-file'
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
  launchFile?: LaunchFile
  launchPrompt?: string
  unstageableLine?: UnstageableLine
  promptOnLaunchCommand: boolean
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
  /** The start action this launch serves. */
  requestId: AgentLaunchRequestId
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
      promptOnLaunchCommand: false,
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
  const {
    startupPlan,
    launchFile,
    launchPrompt,
    unstageableLine,
    promptOnLaunchCommand,
    startupPlanFailed
  } = buildDirectWorkItemStartup({
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
        : undefined,
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(args.latestStore, args.worktreeId)
  })

  const plan =
    effectiveAgent === null
      ? null
      : args.planLaunch(args.latestStore, {
          requestId: args.requestId,
          agent: effectiveAgent,
          workspace: { kind: 'git-worktree', worktreeId: args.worktreeId, repoId: args.repoId },
          prompt: args.draftContent,
          promptDelivery: args.promptDelivery,
          initialSessionOptions: startupPlan?.sessionOptions
        })
  const structuredLaunch = plan?.route === 'structured-native-chat'

  return {
    launchConnectionId,
    unavailable: false,
    effectiveAgent,
    startupPlan,
    ...(launchFile ? { launchFile } : {}),
    ...(launchPrompt ? { launchPrompt } : {}),
    ...(unstageableLine ? { unstageableLine } : {}),
    promptOnLaunchCommand,
    startupPlanFailed,
    structuredLaunch,
    plan
  }
}
