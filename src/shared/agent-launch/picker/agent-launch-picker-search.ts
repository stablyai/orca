import { agentPickerModels } from './agent-launch-picker-catalog'
import { resolveAgentChoiceLayers } from '../choices/agent-choice-layers'
import type { TuiAgent } from '../catalog/tui-agent'
import type { AgentPickerEntry, AgentPickerModel } from './agent-launch-picker'
import type { AgentDedicatedChoices } from '../choices/agent-launch-choices'

export type AgentPickerSetup = {
  entry: AgentPickerEntry
  model: AgentPickerModel
  choices: AgentDedicatedChoices
  label: string
}

const AGENT_SEARCH_ALIASES: Partial<Record<TuiAgent, readonly string[]>> = {
  antigravity: ['agy']
}

function agentPickerEntryAliases(
  entry: Pick<AgentPickerEntry, 'agent' | 'aliases'>
): readonly string[] {
  const builtIn = AGENT_SEARCH_ALIASES[entry.agent] ?? []
  return entry.aliases?.length ? [...builtIn, ...entry.aliases] : builtIn
}

export function filterAgentPickerEntries(
  entries: readonly AgentPickerEntry[],
  query: string
): AgentPickerEntry[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) {
    return [...entries]
  }
  return entries.filter((entry) => {
    const haystack = [entry.agent, entry.label, ...agentPickerEntryAliases(entry)]
      .join(' ')
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

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
    if (!entry.surfaces.length) {
      continue
    }
    const agentWords = tokens(
      [entry.agent, entry.label, ...agentPickerEntryAliases(entry)].join(' ')
    )
    if (words.every((word) => score(word, agentWords))) {
      continue
    }
    for (const model of agentPickerModels(entry)) {
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

/** Every launchable agent's models a query names: all of a named agent's, then model and effort matches. */
export function searchAgentPickerModels(
  entries: readonly AgentPickerEntry[],
  query: string
): AgentPickerSetup[] {
  if (!tokens(query).length) {
    return []
  }
  const named = filterAgentPickerEntries(entries, query).flatMap((entry) =>
    entry.surfaces.length
      ? agentPickerModels(entry)
          .filter((model) => !model.hidden)
          .map((model) => ({ entry, model, choices: { model: model.id }, label: model.label }))
      : []
  )
  // A named agent's rows already list its models; a setup row naming one again would repeat it.
  const listed = new Set(named.map(({ entry, model }) => `${entry.agent}\u0000${model.id}`))
  return [
    ...named,
    ...searchAgentPickerSetups(entries, query, 24).filter(
      ({ entry, model, choices }) =>
        choices.options?.effort !== undefined || !listed.has(`${entry.agent}\u0000${model.id}`)
    )
  ]
}
