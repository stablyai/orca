import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import type { AgentStartedTelemetry } from '@/lib/worktree-activation'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { GlobalSettings, OnboardingState, TuiAgent } from '../../../shared/types'
import { resolveNativeChatSessionOptionDefaults } from '../../../shared/native-chat-session-option-defaults'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'
import { decideInitialAgentTabViewMode } from '@/lib/native-chat-initial-view-mode'

export type OnboardingFolderAgentStartup = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  sessionOptions?: Record<string, SessionOptionValue>
  telemetry: AgentStartedTelemetry
}

function getClientPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  return navigator.userAgent.includes('Mac') ? 'darwin' : 'linux'
}

export function buildOnboardingFolderAgentStartup(
  settings: GlobalSettings | null,
  context?: {
    repoId?: string | null
    connectionId?: string | null
    nativeChatTranscriptIsLocalReadable?: boolean
  }
): OnboardingFolderAgentStartup | undefined {
  const agent = settings?.defaultTuiAgent
  if (
    !settings ||
    !agent ||
    agent === 'blank' ||
    !isTuiAgentEnabled(agent, settings.disabledTuiAgents)
  ) {
    return undefined
  }

  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: settings.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
    sessionOptions:
      decideInitialAgentTabViewMode({
        experimentalNativeChat: settings.experimentalNativeChat,
        openAgentTabsInChatByDefault: settings.openAgentTabsInChatByDefault,
        agent,
        nativeChatTranscriptIsLocalReadable: context?.nativeChatTranscriptIsLocalReadable
      }) === 'chat'
        ? resolveNativeChatSessionOptionDefaults(settings.nativeChatSessionOptions, agent)
        : undefined,
    platform: getClientPlatform(),
    allowEmptyPromptLaunch: true,
    repoId: context?.repoId,
    connectionId: context?.connectionId
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
      launch_source: 'onboarding',
      request_kind: 'new'
    }
  }
}

export function shouldSeedFolderAgentAfterDismissedOnboarding(
  onboarding: OnboardingState | null,
  hasExistingProject: boolean
): boolean {
  return (
    onboarding?.outcome === 'dismissed' &&
    !hasExistingProject &&
    !onboarding.checklist.addedRepo &&
    !onboarding.checklist.addedFolder
  )
}

export function buildDismissedOnboardingFolderAgentStartup(
  settings: GlobalSettings | null,
  onboarding: OnboardingState | null,
  hasExistingProject: boolean,
  context?: {
    repoId?: string | null
    connectionId?: string | null
    nativeChatTranscriptIsLocalReadable?: boolean
  }
): OnboardingFolderAgentStartup | undefined {
  if (!shouldSeedFolderAgentAfterDismissedOnboarding(onboarding, hasExistingProject)) {
    return undefined
  }
  return buildOnboardingFolderAgentStartup(settings, context)
}
