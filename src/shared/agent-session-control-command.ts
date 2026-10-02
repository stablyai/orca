import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { AgentType } from './agent-status-types'
import type { CatalogMidSessionApply } from './agent-session-option-catalog-types'
import type { SessionOptionValue } from './native-chat-session-options'

function commandsFor(
  apply: CatalogMidSessionApply | undefined,
  values: readonly SessionOptionValue[]
): string[] {
  if (!apply || apply.kind === 'unsupported' || apply.kind === 'restart') {
    return []
  }
  if (apply.kind === 'command') {
    return values.map(apply.build)
  }
  return [apply.command]
}

/** Renderer-selected session controls cross an RPC trust boundary; only commands
 * described by the provider catalog may reach an attached agent. */
export function isAgentSessionControlCommand(agent: AgentType, command: string): boolean {
  const catalog = getAgentSessionOptionCatalog(agent)
  if (!catalog) {
    return false
  }
  const allowed = new Set(
    commandsFor(
      catalog.modelApply.midSession,
      catalog.models.map((model) => model.id)
    )
  )
  for (const model of catalog.models) {
    for (const option of model.options) {
      const values =
        option.kind.type === 'select'
          ? option.kind.choices.map((choice) => choice.value)
          : [true, false]
      for (const candidate of commandsFor(option.apply.midSession, values)) {
        allowed.add(candidate)
      }
    }
  }
  if (allowed.has(command)) {
    return true
  }
  // Custom Claude model ids are user-entered but still cross an RPC boundary;
  // admit only the same single-token shape accepted by `/model`.
  return agent === 'claude' && /^\/model [a-z0-9][a-z0-9._:[\]-]{0,127}$/i.test(command)
}
