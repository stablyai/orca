import { agentPickerModels } from './agent-launch-picker-catalog'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import type { AgentPickerEntry, AgentPickerSetup } from './agent-launch-picker'

const tokens = (value: string): string[] =>
  value
    .toLowerCase()
    .replace(/extra[\s-]*high/g, 'xhigh')
    .split(/[\s_\-/·]+/)
    .filter(Boolean)
const score = (word: string, values: readonly string[]): number =>
  values.includes(word)
    ? 2
    : word.length >= 2 && values.some((value) => value.startsWith(word))
      ? 1
      : 0

export function searchAgentPickerSetups(
  entries: readonly AgentPickerEntry[],
  query: string,
  limit = 8
): AgentPickerSetup[] {
  const words = tokens(query)
  if (!words.length) {
    return []
  }
  const matches: { setup: AgentPickerSetup; score: number }[] = []
  for (const entry of entries) {
    if (!entry.surfaces.length || entry.catalog.origin === 'unknown') {
      continue
    }
    const agentWords = tokens([entry.agent, entry.label, ...(entry.aliases ?? [])].join(' '))
    if (words.every((word) => score(word, agentWords))) {
      continue
    }
    for (const model of agentPickerModels(entry)) {
      if (model.isLegacy || model.hidden) {
        continue
      }
      const modelWords = tokens([model.id, model.label].join(' '))
      if (!words.some((word) => !score(word, agentWords) && score(word, modelWords))) {
        continue
      }
      const effortQuery = model.efforts.filter((effort) =>
        words.some(
          (word) =>
            !score(word, agentWords) &&
            !score(word, modelWords) &&
            score(word, tokens(`${effort.value} ${effort.label}`))
        )
      )
      const efforts = effortQuery.length ? effortQuery : [undefined]
      for (const effort of efforts) {
        const effortWords = effort ? tokens(`${effort.value} ${effort.label}`) : []
        const values = words.map((word) =>
          score(word, [...agentWords, ...modelWords, ...effortWords])
        )
        if (values.some((value) => value === 0)) {
          continue
        }
        const choices = resolveAgentChoiceLayers({
          agent: entry.agent,
          explicit: { model: model.id, ...(effort ? { options: { effort: effort.value } } : {}) },
          argumentOwner: 'defaults'
        })
        matches.push({
          setup: {
            entry,
            model,
            choices,
            label: [entry.label, model.label, effort?.label].filter(Boolean).join(' · ')
          },
          score: values.reduce((a, b) => a + b, 0)
        })
      }
    }
  }
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((match) => match.setup)
}
