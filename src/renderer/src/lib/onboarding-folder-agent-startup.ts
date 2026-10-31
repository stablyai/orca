import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { tuiAgentToAgentKind } from '@/lib/telemetry'
import { isTuiAgentEnabled } from '../../../shared/tui-agent-selection'
import { resolveAgentStartupPlanInputs } from '../../../shared/agent-startup-plan-inputs'
import type { AgentStartedTelemetry } from '@/lib/worktree-startup-payload'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session-resume'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { OnboardingState } from '../../../shared/onboarding-state-types'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../shared/tui-agent'

export type OnboardingFolderAgentStartup = {
  command: string
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  startupCommandDelivery?: StartupCommandDelivery
  telemetry: AgentStartedTelemetry
}

type OnboardingStartupHost = {
  platform: NodeJS.Platform
  shell: AgentStartupShell | undefined
  isRemote: boolean
}

export function onboardingFolderDefaultAgent(settings: GlobalSettings | null): TuiAgent | null {
  const agent = settings?.defaultTuiAgent
  return agent && agent !== 'blank' && isTuiAgentEnabled(agent, settings?.disabledTuiAgents)
    ? agent
    : null
}

export function buildOnboardingFolderAgentStartup(
  settings: GlobalSettings | null,
  host: OnboardingStartupHost
): OnboardingFolderAgentStartup | undefined {
  const agent = onboardingFolderDefaultAgent(settings)
  if (!settings || !agent) {
    return undefined
  }

  const startupPlan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({ agent, settings, ...host }),
    prompt: '',
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
