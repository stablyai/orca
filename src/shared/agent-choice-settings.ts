import { findOptionOccurrence } from './command-option-occurrence'
import { agentRequiredValueOptions, removeAgentArgOption } from './agent-session-option-agent-args'
import type { AgentType } from './agent-status-types'

export function readAgentChoiceSettings(
  value: string | undefined
): Record<string, unknown> | undefined {
  if (!value?.trim().startsWith('{')) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : undefined
  } catch {
    return undefined
  }
}

/** Shell settings flags select one value: earlier carriers remain shadowed. */
export function agentChoiceSettingsOccurrences(
  agent: AgentType,
  names: readonly string[],
  tokens: readonly string[]
) {
  const occurrences: { index: number; consumed: number; value?: string }[] = []
  let found = findOptionOccurrence(tokens, names, true, agentRequiredValueOptions(agent))
  while (found) {
    occurrences.push(found)
    found = findOptionOccurrence(
      tokens,
      names,
      true,
      agentRequiredValueOptions(agent),
      found.index + found.consumed
    )
  }
  return occurrences
}

export function mergeAgentChoiceSettings(
  agent: AgentType,
  names: readonly string[],
  tokens: readonly string[],
  key: string,
  value: string | boolean
): string[] {
  return agentChoiceSettingsOccurrences(agent, names, tokens).length
    ? []
    : [names[0], JSON.stringify({ [key]: value })]
}

export function rewriteAgentChoiceSettings(
  agent: AgentType,
  names: readonly string[],
  tokens: readonly string[],
  key: string,
  value: string | boolean
): string[] {
  const effective = agentChoiceSettingsOccurrences(agent, names, tokens).at(-1)
  const settings = readAgentChoiceSettings(effective?.value)
  if (!effective || !settings) {
    return [...tokens]
  }
  const edited = JSON.stringify({ ...settings, [key]: value })
  const result = [...tokens]
  if (effective.consumed === 2) {
    result[effective.index + 1] = edited
  } else {
    result[effective.index] = `${tokens[effective.index].split('=')[0]}=${edited}`
  }
  return result
}

export function agentChoiceSettingsArguments(
  agent: AgentType,
  names: readonly string[],
  tokens: readonly string[]
): Record<string, unknown>[] {
  const effective = agentChoiceSettingsOccurrences(agent, names, tokens).at(-1)
  const settings = readAgentChoiceSettings(effective?.value)
  return settings ? [settings] : []
}

export function withoutInlineAgentChoiceSettings(
  agent: AgentType,
  names: readonly string[],
  tokens: readonly string[]
): string[] {
  const effective = agentChoiceSettingsOccurrences(agent, names, tokens).at(-1)
  return effective && readAgentChoiceSettings(effective.value)
    ? removeAgentArgOption(agent, tokens, names)
    : [...tokens]
}
