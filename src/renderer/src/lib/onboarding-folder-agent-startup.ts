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

export type OnboardingFolderAgentStartup = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  telemetry: AgentStartedTelemetry
}

function getClientPlatform(): NodeJS.Platform {
  if (navigator.userAgent.includes('Windows')) {
    return 'win32'
  }
  return navigator.userAgent.includes('Mac') ? 'darwin' : 'linux'
}

export function buildOnboardingFolderAgentStartup(
  settings: GlobalSettings | null
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
    platform: getClientPlatform(),
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
  hasExistingProject: boolean
): OnboardingFolderAgentStartup | undefined {
  if (!shouldSeedFolderAgentAfterDismissedOnboarding(onboarding, hasExistingProject)) {
    return undefined
  }
  return buildOnboardingFolderAgentStartup(settings)
}
