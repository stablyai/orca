import type { TuiAgent } from '../../../shared/tui-agent'
import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { AppState } from '@/store/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import {
  buildDirectWorkItemAgentStartupPlan,
  buildDirectWorkItemStartupOpts
} from '@/lib/launch-work-item-direct-agent'
import { startStructuredCodexLaunch } from '@/lib/structured-agent-session-launch'
import { StructuredAgentSessionCreateRefusalError } from '@/lib/launch-structured-codex-session'
import { isNativeChatTranscriptLocalReadable } from '@/lib/native-chat-transcript-readability'
import { resolveSourceControlLaunchPlatform } from '@/lib/source-control-launch-platform'
import { preflightAgentTrust } from '@/lib/agent-trust-preflight'

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

export async function markDirectWorkItemAgentTrusted(args: {
  structuredLaunch: boolean
  agent: TuiAgent | null
  workspacePath: string
  connectionId: string | null
}): Promise<void> {
  if (args.structuredLaunch || !args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preflight = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preflight) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still dismiss the agent trust prompt manually.
  }
}

export async function settleDirectWorkItemStructuredLaunch(args: {
  structuredLaunch: boolean
  agent: TuiAgent | null
  worktreeId: string
  workspacePath: string
  connectionId: string | null
  draftContent: string
  promptDelivery: PromptDelivery
  primaryTabId: string | null
  startupPlan: AgentStartupPlan | null
  launchSource: LaunchSource
}): Promise<{
  completed: boolean
  structuredLaunch: boolean
  visibilityUnknown: boolean
  primaryTabId: string | null
}> {
  let { structuredLaunch, primaryTabId } = args
  if (!structuredLaunch || args.agent !== 'codex') {
    return { completed: false, structuredLaunch, visibilityUnknown: false, primaryTabId }
  }

  const launch = startStructuredCodexLaunch(args.worktreeId, {
    prompt: args.draftContent,
    ...(args.promptDelivery === 'submit-after-ready' ? { promptDelivery: args.promptDelivery } : {})
  })
  const refusalFallback = launch.claimDefinitiveRefusalFallback(async () => {
    structuredLaunch = false
    await preflightAgentTrust({
      agent: args.agent,
      workspacePath: args.workspacePath,
      connectionId: args.connectionId
    })
    const fallbackActivation = activateAndRevealWorktree(args.worktreeId, {
      sidebarRevealBehavior: 'auto',
      createNewTerminalForStartup: true,
      ...buildDirectWorkItemStartupOpts(
        args.agent,
        args.startupPlan,
        args.launchSource,
        args.promptDelivery === 'draft' ? args.draftContent : undefined
      )
    })
    primaryTabId = fallbackActivation === false ? null : fallbackActivation.primaryTabId
  })
  try {
    await launch.launchResult
    return { completed: true, structuredLaunch, visibilityUnknown: false, primaryTabId }
  } catch (error) {
    if (!(error instanceof StructuredAgentSessionCreateRefusalError)) {
      const visibilityUnknown = launch.isVisibilityUnknown()
      return {
        completed: !visibilityUnknown,
        structuredLaunch,
        visibilityUnknown,
        primaryTabId
      }
    }
    await refusalFallback
  }
  return { completed: false, structuredLaunch, visibilityUnknown: false, primaryTabId }
}
