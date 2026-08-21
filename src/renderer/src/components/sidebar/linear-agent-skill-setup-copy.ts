import type { LocalAgentRuntime } from '../settings/CliSkillRuntimeSetup'
import { translate } from '@/i18n/i18n'

export function getLinearAgentSkillSetupMissingLabel(
  cliAvailable: boolean,
  skillInstalled: boolean
): string {
  if (!cliAvailable && !skillInstalled) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCliAndSkill',
      'MCode CLI and Linear agent skill are missing.'
    )
  }
  if (!cliAvailable) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingCli',
      'MCode CLI is missing.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.missingSkill',
    'Linear agent skill is missing.'
  )
}

export function getLinearAgentSkillSetupToastTitle(
  cliAvailable: boolean,
  skillInstalled: boolean
): string {
  if (!cliAvailable && !skillInstalled) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingCliAndSkill',
      'MCode CLI and Linear skill are missing'
    )
  }
  if (!cliAvailable) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingCli',
      'MCode CLI is missing'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastMissingSkill',
    'Linear skill is missing'
  )
}

export function getLinearAgentSkillSetupToastDescription(
  cliAvailable: boolean,
  skillInstalled: boolean,
  remote: boolean,
  agentRuntime: LocalAgentRuntime
): string {
  const baseDescription = getLinearAgentSkillSetupToastBaseDescription(cliAvailable, skillInstalled)
  if (remote) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastRemoteDescription',
      '{{value0}} Remote agent environments may need their own setup.',
      { value0: baseDescription }
    )
  }
  if (agentRuntime.runtime === 'wsl') {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastWslDescription',
      '{{value0}} This setup runs in the selected WSL agent runtime.',
      { value0: baseDescription }
    )
  }
  return baseDescription
}

function getLinearAgentSkillSetupToastBaseDescription(
  cliAvailable: boolean,
  skillInstalled: boolean
): string {
  if (!cliAvailable && !skillInstalled) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastInstallCliAndSkillDescription',
      'Install the MCode CLI and the Linear skill to enable your agents to read and edit Linear tasks.'
    )
  }
  if (!cliAvailable) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastInstallCliDescription',
      'Install the MCode CLI to enable your agents to read and edit Linear tasks.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.toastInstallSkillDescription',
    'Install the Linear skill to enable your agents to read and edit Linear tasks through the MCode CLI.'
  )
}

export function getLinearAgentSkillSetupInlineRuntimeCopy(
  remote: boolean,
  agentRuntime: LocalAgentRuntime
): string {
  if (remote) {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.remoteCopy',
      'This installs host setup; remote agent environments may need separate setup.'
    )
  }
  if (agentRuntime.runtime === 'wsl') {
    return translate(
      'auto.components.sidebar.LinearAgentSkillSetupPrompt.wslCopy',
      'Install it for WSL agent handoffs from linked Linear work.'
    )
  }
  return translate(
    'auto.components.sidebar.LinearAgentSkillSetupPrompt.hostCopy',
    'Install it for host agent handoffs from linked Linear work.'
  )
}
