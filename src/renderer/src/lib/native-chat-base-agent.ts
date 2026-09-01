import type { AgentType } from '../../../shared/agent-status-types'
import type { CustomTuiAgent, DeletedCustomTuiAgent, TuiAgent } from '../../../shared/tui-agent'
import { isCustomTuiAgentId, resolveTuiAgentBaseAgent } from '../../../shared/custom-tui-agents'

/** The catalog slice every native-chat gate threads through, so the pure
 *  decision modules can resolve a custom agent id without importing the store. */
export type NativeChatAgentCatalogInput = {
  customTuiAgents?: readonly CustomTuiAgent[] | null
  deletedCustomTuiAgents?: readonly DeletedCustomTuiAgent[] | null
}

/** Map an agent id onto the built-in the native-chat registries are keyed by, so
 *  a custom agent inherits its base harness's chat surface. Fails closed: a
 *  custom id with neither definition nor tombstone stays raw, and the
 *  built-in-keyed registry rejects it exactly as it does today. */
export function resolveNativeChatBaseAgent(
  agent: TuiAgent,
  catalog: NativeChatAgentCatalogInput
): TuiAgent
export function resolveNativeChatBaseAgent(
  agent: AgentType | null | undefined,
  catalog: NativeChatAgentCatalogInput
): AgentType | null | undefined
export function resolveNativeChatBaseAgent(
  agent: AgentType | null | undefined,
  catalog: NativeChatAgentCatalogInput
): AgentType | null | undefined {
  if (!isCustomTuiAgentId(agent)) {
    return agent
  }
  return (
    resolveTuiAgentBaseAgent(agent, catalog.customTuiAgents, catalog.deletedCustomTuiAgents) ??
    agent
  )
}
