import type { AutomationLaunchSetup } from './automation-launch-types'
import { automationCanonicalLaunchSetup } from './automation-canonical-launch-setup'
import { newChatPermissionMode } from '../../agent-launch/permissions/agent-chat-permission-mode'
import { agentPermissionChoices } from '../../agent-launch/permissions/tui-agent-permission-choice'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

export type AutomationPermissionSettings = {
  automationFullAccess?: boolean
  fullAccessBotIds?: string[]
}

export function automationChatPermissionMode(
  agent: string,
  settings: AutomationPermissionSettings,
  automation: boolean | undefined,
  fallback: unknown,
  botId?: string
) {
  const required =
    (automation && settings.automationFullAccess === true) ||
    (botId !== undefined && settings.fullAccessBotIds?.includes(botId) === true)
  const choice = required ? 'full-access' : fallback
  const mode = choice ? newChatPermissionMode(agent, choice) : null
  if (required && mode !== 'full-access') {
    throw new Error(`${agent} cannot start this automation with Full Access.`)
  }
  return mode
}

export function automationWithFullAccess<
  T extends AutomationLaunchSetup & { agentId: TuiAgent; launchSetup?: AutomationLaunchSetup }
>(automation: T, enabled: boolean): T {
  if (!enabled) {
    return automation
  }
  if (!agentPermissionChoices(automation.agentId).includes('full-access')) {
    throw new Error(`${automation.agentId} cannot start this automation with Full Access.`)
  }
  const setup = automationCanonicalLaunchSetup(automation)
  const launchSetup = {
    ...setup,
    launchPreferences: { ...setup.launchPreferences, permissionMode: 'full-access' as const }
  }
  return { ...automation, ...launchSetup, launchSetup }
}
