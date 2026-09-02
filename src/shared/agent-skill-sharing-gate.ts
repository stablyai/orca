import type { GlobalSettings } from './global-settings-types'

export const AGENT_SKILL_SHARING_DISABLED_CODE = 'agent_skill_sharing_disabled'

export const AGENT_SKILL_SHARING_DISABLED_MESSAGE =
  'Publishing skill links from agents and the Orca CLI is off for this device.'

export const AGENT_SKILL_SHARING_DISABLED_NEXT_STEPS: readonly string[] = [
  'Open Settings → Share Skills in the Orca desktop app on this device.',
  'Turn on "Allow agents and the Orca CLI to publish skill links".',
  'Run the share command again.'
]

export class AgentSkillSharingDisabledError extends Error {
  readonly code = AGENT_SKILL_SHARING_DISABLED_CODE
  readonly data = { nextSteps: [...AGENT_SKILL_SHARING_DISABLED_NEXT_STEPS] }

  constructor() {
    super(AGENT_SKILL_SHARING_DISABLED_MESSAGE)
    this.name = 'AgentSkillSharingDisabledError'
  }
}

export function isAgentSkillSharingEnabled(
  settings: Pick<GlobalSettings, 'agentSkillSharingEnabled'> | null | undefined
): boolean {
  return settings?.agentSkillSharingEnabled === true
}

export function assertAgentSkillSharingAllowed(isEnabled: () => boolean): void {
  if (!isEnabled()) {
    throw new AgentSkillSharingDisabledError()
  }
}
