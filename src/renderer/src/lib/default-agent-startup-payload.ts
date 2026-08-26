import { buildAgentStartupPlan } from '../../../shared/tui-agent-startup'
import { tuiAgentToAgentKind } from '../../../shared/agent-kind'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveInitialNativeChatSessionOptions } from '@/components/native-chat/native-chat-launch-session-options'
import type { WorktreeStartupPayload } from '@/lib/worktree-startup-payload'

export function resolveEmptyWorktreeDefaultAgent(args: {
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'disabledTuiAgents'> | null | undefined
  detectedAgentIds: readonly TuiAgent[] | null | undefined
}): TuiAgent | null {
  const preferred = args.settings?.defaultTuiAgent
  if (preferred === 'blank') {
    return null
  }
  if (preferred) {
    return isTuiAgentEnabled(preferred, args.settings?.disabledTuiAgents) ? preferred : null
  }
  return pickTuiAgent(null, args.detectedAgentIds ?? [], args.settings?.disabledTuiAgents)
}

export function buildDefaultAgentStartupPayload(args: {
  agent: TuiAgent
  settings: GlobalSettings
  launchSource: LaunchSource
  platform: NodeJS.Platform
  nativeChatTranscriptIsLocalReadable?: boolean
  isRemote?: boolean
  shell?: AgentStartupShell
}): WorktreeStartupPayload | undefined {
  const {
    agent,
    settings,
    launchSource,
    platform,
    nativeChatTranscriptIsLocalReadable = true,
    isRemote,
    shell
  } = args
  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions: resolveInitialNativeChatSessionOptions(settings, {
      agent,
      nativeChatTranscriptIsLocalReadable
    }),
    platform,
    ...(shell ? { shell } : {}),
    ...(isRemote !== undefined ? { isRemote } : {}),
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    return undefined
  }

  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(startupPlan.sessionOptions ? { sessionOptions: startupPlan.sessionOptions } : {}),
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: launchSource,
      request_kind: 'new'
    }
  }
}
