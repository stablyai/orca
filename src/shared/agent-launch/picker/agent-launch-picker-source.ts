import {
  modelCatalogSource,
  type ModelCatalogSource
} from '../../agent-session/options/model-catalog-source'
import type {
  AgentPickerEntry,
  AgentPickerSurface,
  AgentPickerCatalogView
} from './agent-launch-picker'

const pending: AgentPickerCatalogView = {
  catalog: { origin: 'unknown' },
  catalogRead: 'pending',
  coherentCatalog: true
}

export function agentPickerCatalogSource(entry: AgentPickerEntry, surface = entry.defaultSurface) {
  return entry.textGeneration ? 'structured' : modelCatalogSource(entry.agent, surface)
}

export function agentPickerSourceView(
  entry: AgentPickerEntry,
  source: ModelCatalogSource
): AgentPickerCatalogView {
  return source === 'structured' ? entry : (entry.sourceCatalogs?.[source] ?? pending)
}

export function agentPickerCatalogView(
  entry: AgentPickerEntry,
  surface: AgentPickerSurface = entry.defaultSurface
) {
  return agentPickerSourceView(entry, agentPickerCatalogSource(entry, surface))
}

export function withAgentPickerSourceView(
  entry: AgentPickerEntry,
  source: ModelCatalogSource,
  view: AgentPickerCatalogView
): AgentPickerEntry {
  return source === 'structured'
    ? { ...entry, ...view }
    : { ...entry, sourceCatalogs: { ...entry.sourceCatalogs, [source]: view } }
}

export function agentPickerCatalogSources(entry: AgentPickerEntry): ModelCatalogSource[] {
  return [...new Set(entry.surfaces.map((surface) => agentPickerCatalogSource(entry, surface)))]
}
