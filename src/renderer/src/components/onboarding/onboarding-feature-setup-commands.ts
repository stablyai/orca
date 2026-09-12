import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCA_LINEAR_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME,
  buildAgentFeatureSkillInstallCommand,
  buildUnattendedAgentFeatureSkillInstallCommand
} from '@/lib/agent-feature-install-commands'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import { buildSkillCommandForRuntime } from '../settings/CliSkillRuntimeSetup'
import type {
  OnboardingFeatureSetupId,
  OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'

const FEATURE_SKILL_NAMES: Record<OnboardingFeatureSetupId, string> = {
  browserUse: ORCA_CLI_SKILL_NAME,
  computerUse: COMPUTER_USE_SKILL_NAME,
  orchestration: ORCHESTRATION_SKILL_NAME,
  linearTickets: ORCA_LINEAR_SKILL_NAME
}

function selectedOnboardingFeatureSkillNames(selection: OnboardingFeatureSetupSelection): string[] {
  return (Object.keys(FEATURE_SKILL_NAMES) as OnboardingFeatureSetupId[])
    .filter((id) => selection[id])
    .map((id) => FEATURE_SKILL_NAMES[id])
}

export function buildOnboardingFeatureSetupClipboardText(
  selection: OnboardingFeatureSetupSelection,
  agentRuntime?: ProjectAgentSkillRuntime
): string | null {
  const command = buildOnboardingFeatureSetupSkillCommand(selection)
  return command === null ? null : buildSkillCommandForRuntime(command, agentRuntime)
}

export function buildOnboardingFeatureSetupSkillCommand(
  selection: OnboardingFeatureSetupSelection
): string | null {
  const skillNames = selectedOnboardingFeatureSkillNames(selection)
  if (skillNames.length === 0) {
    return null
  }
  return buildAgentFeatureSkillInstallCommand(skillNames)
}

export function buildOnboardingFeatureSetupTerminalCommand(
  selection: OnboardingFeatureSetupSelection
): string | null {
  const skillNames = selectedOnboardingFeatureSkillNames(selection)
  if (skillNames.length === 0) {
    return null
  }
  return buildUnattendedAgentFeatureSkillInstallCommand(skillNames)
}
