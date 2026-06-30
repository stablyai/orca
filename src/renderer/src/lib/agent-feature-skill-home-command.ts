import {
  buildAgentFeatureSkillHomeCommand,
  type AgentFeatureSkillCommandShell
} from '../../../shared/agent-feature-install-commands'

export function getAgentFeatureSkillCommandPlatform(): NodeJS.Platform {
  const platform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (platform) {
    return platform
  }

  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  return 'linux'
}

export function getAgentFeatureSkillCommandShell(
  platform: NodeJS.Platform
): AgentFeatureSkillCommandShell {
  return platform === 'win32' ? 'windows-powershell' : 'posix'
}

export function buildAgentFeatureSkillHomeCommandForPlatform(
  command: string,
  platform: NodeJS.Platform = getAgentFeatureSkillCommandPlatform()
): string {
  return buildAgentFeatureSkillHomeCommand(command, getAgentFeatureSkillCommandShell(platform))
}
