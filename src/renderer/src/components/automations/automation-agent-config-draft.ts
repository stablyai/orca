import { normalizeAutomationAgentConfig } from '../../../../shared/automation-agent-config'
import type { AutomationAgentConfig } from '../../../../shared/automations-types'
import { createBrowserUuid } from '@/lib/browser-uuid'

/** Editable env entry. Kept as an ordered list (not a record) so the editor can
 *  hold rows with blank keys while the user is still typing. `id` is a stable
 *  React key so removing a middle row doesn't reassign inputs to wrong rows. */
export type AgentEnvDraftEntry = {
  id: string
  key: string
  value: string
}

export function createAgentEnvDraftEntry(key = '', value = ''): AgentEnvDraftEntry {
  return { id: createBrowserUuid(), key, value }
}

/** The agent-config slice of the automation draft. */
export type AgentConfigDraftFields = {
  agentModel: string
  agentLaunchArgs: string
  agentEnv: AgentEnvDraftEntry[]
}

export const EMPTY_AGENT_CONFIG_DRAFT_FIELDS: AgentConfigDraftFields = {
  agentModel: '',
  agentLaunchArgs: '',
  agentEnv: []
}

/** Build a persisted agent config from the draft fields, or null when nothing
 *  is configured. */
export function draftToAgentConfig(fields: AgentConfigDraftFields): AutomationAgentConfig | null {
  const env: Record<string, string> = {}
  for (const entry of fields.agentEnv) {
    const key = entry.key.trim()
    if (key) {
      env[key] = entry.value
    }
  }
  return normalizeAutomationAgentConfig({
    launchArgs: fields.agentLaunchArgs,
    model: fields.agentModel,
    env
  })
}

/** Expand a persisted agent config into editable draft fields. */
export function agentConfigToDraftFields(
  config: AutomationAgentConfig | null | undefined
): AgentConfigDraftFields {
  if (!config) {
    return { ...EMPTY_AGENT_CONFIG_DRAFT_FIELDS }
  }
  return {
    agentModel: config.model ?? '',
    agentLaunchArgs: config.launchArgs ?? '',
    agentEnv: Object.entries(config.env ?? {}).map(([key, value]) =>
      createAgentEnvDraftEntry(key, value)
    )
  }
}
