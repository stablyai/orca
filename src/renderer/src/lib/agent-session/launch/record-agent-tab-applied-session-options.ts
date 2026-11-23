import { useAppStore } from '@/store/index'
import { seedNativeChatAppliedSessionOptions } from '../../../../../shared/native-chat/input/session-options/native-chat-session-option-cache'
import type { SessionOptionValue } from '../../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { getAgentSessionOptionCatalog } from '../../../../../shared/agent-session/options/agent-session-option-catalog'
import { decodeCatalogOptionValue } from '../../../../../shared/agent-session/options/selection/structured-agent-session-option-codec'

/** Seeds both desktop and paired phones with the launch options. */
export function recordAgentTabAppliedSessionOptions(
  tabId: string,
  agent: TuiAgent,
  rawValues: Record<string, SessionOptionValue> | null | undefined
): void {
  const values = rawValues ? decodeLaunchValues(agent, rawValues) : rawValues
  seedNativeChatAppliedSessionOptions(tabId, agent, values)
  // Mirrors the seed's own early return: no model, nothing to show.
  if (values && typeof values.model === 'string' && values.model) {
    useAppStore.getState().setNativeChatAppliedSessionOptions(tabId, { agent, values })
  }
}

// New-tab launches carry saved choices as strings; record booleans as the host applies them.
function decodeLaunchValues(
  agent: TuiAgent,
  values: Record<string, SessionOptionValue>
): Record<string, SessionOptionValue> {
  const catalog = getAgentSessionOptionCatalog(agent)
  const options = [
    ...(catalog?.models.flatMap((model) => model.options) ?? []),
    ...(catalog?.unknownModelOptions ?? [])
  ]
  const decoded: Record<string, SessionOptionValue> = {}
  for (const [id, value] of Object.entries(values)) {
    const option = options.find((candidate) => candidate.id === id)
    const next = option ? decodeCatalogOptionValue(option.kind, value) : value
    if (next !== undefined) {
      decoded[id] = next
    }
  }
  return decoded
}
