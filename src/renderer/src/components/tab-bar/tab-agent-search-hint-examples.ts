import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { agentPickerModels } from '../../../../shared/agent-launch-picker-catalog'
import { searchAgentPickerSetups } from '../../../../shared/agent-launch-picker-search'

export function getTabAgentSearchHintExamples(entries: readonly AgentPickerEntry[]): string[] {
  const examples: string[] = []
  for (const entry of entries) {
    if (!entry.surfaces.length || entry.catalog.origin === 'unknown') {
      continue
    }
    const models = agentPickerModels(entry)
    const model =
      models.find((model) => model.isDefault && !model.isLegacy && !model.hidden) ??
      models.find((model) => !model.isLegacy && !model.hidden)
    if (!model) {
      continue
    }
    // Bound validation to two queries per entry instead of searching for every model.
    for (const query of new Set([model.label.trim(), model.id.trim()])) {
      if (!query || examples.includes(query)) {
        continue
      }
      const first = searchAgentPickerSetups(entries, query, 1)[0]
      if (first?.entry.agent === entry.agent && first.choices.model === model.id) {
        examples.push(query)
        break
      }
    }
    if (examples.length === 2) {
      break
    }
  }
  return examples
}
