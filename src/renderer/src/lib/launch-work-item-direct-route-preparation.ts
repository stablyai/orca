import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { getConnectionId } from '@/lib/connection-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  hasExplicitTuiAgentArgs,
  hasExplicitTuiLaunchCustomization,
  type AgentLaunchRoute,
  type AgentLaunchRoutingInput
} from '@/lib/agent-launch-routing'
import { readLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
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
}

export async function prepareDirectWorkItemAgentLaunch(args: {
  worktreeId: string
  worktreePath: string
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
  routeResolver: (input: AgentLaunchRoutingInput) => AgentLaunchRoute
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
      structuredLaunch: false
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

  const structuredLaunch =
    effectiveAgent !== null &&
    args.routeResolver({
      agent: effectiveAgent,
      settings: args.settings,
      executionHostId: getExecutionHostIdForWorktree(args.latestStore, args.worktreeId),
      platform: CLIENT_PLATFORM,
      hostCapabilities: readLocalRuntimeCapabilities(),
      workspaceKind: 'git-worktree',
      projectRuntime: getLocalProjectExecutionRuntimeContext(
        args.latestStore,
        args.worktreeId,
        CLIENT_PLATFORM
      ),
      promptDelivery: args.promptDelivery,
      launchText: args.draftContent,
      nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(launchConnectionId),
      requiresTuiLaunchCustomization:
        hasExplicitTuiAgentArgs(effectiveAgent, args.agentArgs) ||
        hasExplicitTuiLaunchCustomization(args.settings, effectiveAgent),
      initialSessionOptions: startupPlan?.sessionOptions
    }) === 'structured-native-chat'

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
    structuredLaunch
  }
}
