import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { AppState } from '@/store/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { buildDirectWorkItemAgentStartupPlan } from '@/lib/launch-work-item-direct-agent'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'
import { launchAgentSession } from '@/lib/launch-agent-session'
import { useAppStore } from '@/store'

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

/** Why: kept apart from the refusal fallback's preflight because it runs before
 *  launch on the legacy route only; structured chat has no TUI trust menu. */
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

export async function settleDirectWorkItemStructuredLaunch(args: {
  plan: AgentSessionLaunchPlan | null
  worktreeId: string
  workspacePath: string
  connectionId: string | null
  primaryTabId: string | null
  startupPlan: AgentStartupPlan | null
  launchSource: LaunchSource
  agentArgs?: string | null
  launchPlatform?: NodeJS.Platform
}): Promise<{
  completed: boolean
  structuredLaunch: boolean
  visibilityUnknown: boolean
  /** The structured launch ended without a surface; there is nothing for the legacy path to finish. */
  failed: boolean
  primaryTabId: string | null
}> {
  const { plan } = args
  const notLaunched = (structuredLaunch: boolean) => ({
    completed: false,
    structuredLaunch,
    visibilityUnknown: false,
    failed: false,
    primaryTabId: args.primaryTabId
  })
  if (plan?.route !== 'structured-native-chat') {
    return notLaunched(false)
  }
  const { agent } = plan
  // Why no tab: the pre-launch tab is the setup shell or default tab, never an agent tab, so
  // handing it back would paste the prompt there.
  const withoutAgentSurface = {
    completed: false,
    structuredLaunch: true,
    visibilityUnknown: false,
    failed: true,
    primaryTabId: null
  }
  let settlement: Awaited<ReturnType<typeof launchAgentSession>>
  try {
    settlement = await launchAgentSession(useAppStore.getState(), {
      agent,
      workspaceId: args.worktreeId,
      prompt: plan.prompt,
      ...(plan.promptDelivery ? { promptDelivery: plan.promptDelivery } : {}),
      ...(args.agentArgs !== undefined ? { tuiCustomization: { agentArgs: args.agentArgs } } : {}),
      ...(args.launchPlatform ? { launchPlatform: args.launchPlatform } : {}),
      visibility: 'reveal',
      launchSource: args.launchSource
    })
  } catch {
    // Why: this runs outside the caller's try, so an escaped throw would surface as an unhandled
    // rejection rather than the failure the caller already knows how to report.
    return withoutAgentSurface
  }
  if (!settlement) {
    return notLaunched(true)
  }
  switch (settlement.kind) {
    case 'structured':
      return {
        completed: true,
        structuredLaunch: true,
        visibilityUnknown: false,
        failed: false,
        primaryTabId: args.primaryTabId
      }
    case 'terminal':
      return {
        completed: false,
        structuredLaunch: false,
        visibilityUnknown: false,
        failed: false,
        primaryTabId: settlement.tabId
      }
    case 'visibility-unknown':
      return {
        completed: false,
        structuredLaunch: true,
        visibilityUnknown: true,
        failed: false,
        primaryTabId: args.primaryTabId
      }
    case 'failed':
    case 'cancelled':
      // Why: the launch layer already toasted the failure.
      return withoutAgentSurface
  }
}
