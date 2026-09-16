import type { TuiAgent } from '../../../shared/tui-agent'
import type { AppState } from '@/store/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { buildDirectWorkItemAgentStartupPlan } from '@/lib/launch-work-item-direct-agent'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'

export function buildDirectWorkItemStartup(args: {
  agent: TuiAgent | null
  agentArgs?: string | null
  draftContent: string
  promptDelivery: PromptDelivery
  settings: AppState['settings']
  launchPlatform?: NodeJS.Platform
  launchConnectionId: string | null
  worktreePath: string
  repoProjectRuntime?: Parameters<typeof resolveSourceControlLaunchPlatform>[0]['projectRuntime']
}): ReturnType<typeof buildDirectWorkItemAgentStartupPlan> {
  const launchPlatform =
    args.launchPlatform ??
    resolveSourceControlLaunchPlatform({
      connectionId: args.launchConnectionId,
      worktreePath: args.worktreePath,
      projectRuntime: args.repoProjectRuntime
    })
  return buildDirectWorkItemAgentStartupPlan({
    agent: args.agent,
    agentArgs: args.agentArgs,
    draftContent: args.draftContent,
    promptDelivery: args.promptDelivery,
    settings: args.settings,
    launchPlatform,
    nativeChatTranscriptIsLocalReadable: isNativeChatTranscriptLocalReadable(
      args.launchConnectionId
    ),
    // Why: SSH hosts run the plain `orca` shim, so the Linux-only `orca-ide` rename is not applied.
    isRemote: typeof args.launchConnectionId === 'string'
  })
}

type PromptDelivery = 'draft' | 'submit-after-ready'

export async function resolveDirectWorkItemAgent(args: {
  agentOverride?: TuiAgent
  launchConnectionId: string | null
  repoConnectionId: string | null
  detectedAgentsPromise: Promise<string[]> | null
  latestStore: AppState
}): Promise<{ agent: TuiAgent | null; unavailable: boolean }> {
  const detectedAgents =
    args.agentOverride !== undefined
      ? args.launchConnectionId
        ? await args.latestStore.ensureRemoteDetectedAgents(args.launchConnectionId)
        : await args.latestStore.ensureDetectedAgents()
      : args.launchConnectionId === args.repoConnectionId
        ? await args.detectedAgentsPromise!
        : args.launchConnectionId
          ? await args.latestStore.ensureRemoteDetectedAgents(args.launchConnectionId)
          : await args.latestStore.ensureDetectedAgents()
  if (args.agentOverride !== undefined) {
    return {
      agent: args.agentOverride,
      unavailable:
        !detectedAgents.includes(args.agentOverride) ||
        !isTuiAgentEnabled(args.agentOverride, args.latestStore.settings?.disabledTuiAgents)
    }
  }
  return {
    agent: pickTuiAgent(
      args.latestStore.settings?.defaultTuiAgent,
      new Set(detectedAgents.filter((agent): agent is TuiAgent => agent in TUI_AGENT_CONFIG)),
      args.latestStore.settings?.disabledTuiAgents
    ),
    unavailable: false
  }
}

/** Why: runs only before the legacy route; structured chat has no TUI trust menu. */
export async function markDirectWorkItemAgentTrusted(args: {
  structuredLaunch: boolean
  agent: TuiAgent | null
  workspacePath: string
  connectionId: string | null
}): Promise<void> {
  if (args.structuredLaunch) {
    return
  }
  await preflightAgentTrust({
    agent: args.agent,
    workspacePath: args.workspacePath,
    connectionId: args.connectionId
  })
}

export function beginDirectWorkItemStructuredLaunch(args: {
  plan: AgentSessionLaunchPlan | null
  primaryTabId: string | null
  beforeOpen: (sessionId: string) => boolean | void
}): {
  completed: boolean
  structuredLaunch: boolean
  primaryTabId: string | null
} {
  const { plan } = args
  const notLaunched = (structuredLaunch: boolean) => ({
    completed: false,
    structuredLaunch,
    primaryTabId: args.primaryTabId
  })
  if (plan?.route !== 'structured-native-chat') {
    return notLaunched(false)
  }
  const launch = beginStructuredAgentSessionProvisionalLaunch({
    plan,
    hooks: {},
    beforeOpen: args.beforeOpen
  })
  if (!launch) {
    return notLaunched(true)
  }
  return {
    completed: true,
    structuredLaunch: true,
    primaryTabId: launch.tab.id
  }
}
