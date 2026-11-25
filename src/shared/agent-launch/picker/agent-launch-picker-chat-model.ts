import { getAgentSessionOptionCatalog } from '../../agent-session/options/agent-session-option-catalog'
import { agentPickerCatalogAuthoritative } from './agent-launch-picker-authority'
import type { AgentPickerEntry } from './agent-launch-picker'

export type AgentPickerChatModelRefusal = 'unproven' | 'unlisted' | 'shared'

/** The model a chat launch runs for the form's pick, where the form lists terminal selectors. */
export function agentPickerChatLaunchModel(
  entry: AgentPickerEntry,
  model: string | undefined
): { model: string | undefined } | { refusal: AgentPickerChatModelRefusal } {
  const chatModelId = getAgentSessionOptionCatalog(entry.agent)?.chatModelId
  if (!chatModelId || model === undefined) {
    return { model }
  }
  if (!agentPickerCatalogAuthoritative(entry)) {
    return { refusal: 'unproven' }
  }
  const listed = entry.catalog.models.map((row) => row.id)
  if (!listed.includes(model)) {
    return { refusal: 'unlisted' }
  }
  const id = chatModelId(model, listed)
  return id === null ? { refusal: 'shared' } : { model: id }
}
