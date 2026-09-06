import { acpHandleProvider } from './acp-agent-recipes'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import type { AgentSessionOptionsResult } from './agent-session-wire'
import type { AgentType } from './agent-status-types'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat-session-options'

export const STRUCTURED_SWITCHABLE_AGENTS = ['claude', 'codex', 'grok', 'cursor'] as const

export type StructuredSwitchableAgent = (typeof STRUCTURED_SWITCHABLE_AGENTS)[number]

export function structuredModelChoiceValue(agent: string, modelId: string): string {
  return `${agent}:${modelId}`
}

export function parseStructuredModelChoice(
  value: string
): { agent: StructuredSwitchableAgent; modelId: string } | null {
  const separator = value.indexOf(':')
  if (separator <= 0) {
    return null
  }
  const agent = value.slice(0, separator)
  const modelId = value.slice(separator + 1)
  if (
    modelId.length === 0 ||
    (agent !== 'claude' && agent !== 'codex' && agent !== 'grok' && agent !== 'cursor')
  ) {
    return null
  }
  return { agent, modelId }
}

export function structuredSwitchableAgentLabel(agent: string): string {
  if (agent === 'claude' || agent === 'openclaude') {
    return 'Claude'
  }
  if (agent === 'grok') {
    return 'Grok'
  }
  if (agent === 'cursor') {
    return 'Cursor'
  }
  return 'Codex'
}

export function catalogAgentForStructuredSession(agent: AgentType): StructuredSwitchableAgent {
  return agent === 'openclaude' ? 'claude' : (agent as StructuredSwitchableAgent)
}

export function withSwitchableStructuredModels(
  snapshot: SessionOptionDescriptor[],
  input: {
    currentAgent: AgentType
    live: AgentSessionOptionsResult | null
    supportedByAgent: Readonly<Partial<Record<StructuredSwitchableAgent, boolean>>>
  }
): SessionOptionDescriptor[] {
  const model = snapshot.find(
    (descriptor) => descriptor.category === 'model' && descriptor.kind.type === 'select'
  )
  if (!model || model.kind.type !== 'select') {
    return snapshot
  }
  const currentCatalogAgent = catalogAgentForStructuredSession(input.currentAgent)
  const choices: SessionOptionSelectChoice[] = []
  for (const agent of STRUCTURED_SWITCHABLE_AGENTS) {
    const catalog = getAgentSessionOptionCatalog(agent)
    const liveModels =
      agent === currentCatalogAgent
        ? (input.live?.models ??
          model.kind.choices.map((choice) => ({
            id: parseStructuredModelChoice(choice.value)?.modelId ?? choice.value,
            label: choice.label,
            description: choice.description
          })))
        : undefined
    const models =
      liveModels && liveModels.length > 0
        ? liveModels
        : (catalog?.models ?? []).map((entry) => ({
            id: entry.id,
            label: entry.label,
            description: entry.description,
            isDefault: Boolean(entry.isDefault),
            efforts: []
          }))
    const supported = agent === currentCatalogAgent || input.supportedByAgent[agent] === true
    const group = structuredSwitchableAgentLabel(agent)
    for (const entry of models) {
      choices.push({
        value: structuredModelChoiceValue(agent, entry.id),
        label: entry.label,
        ...(entry.description ? { description: entry.description } : {}),
        group,
        disabled: !supported
      })
    }
  }
  const trackedModel =
    model.kind.type === 'select' && typeof model.kind.currentValue === 'string'
      ? (parseStructuredModelChoice(model.kind.currentValue)?.modelId ?? model.kind.currentValue)
      : undefined
  const currentModel = trackedModel || input.live?.current.model
  const currentValue =
    typeof currentModel === 'string' && currentModel.length > 0
      ? structuredModelChoiceValue(currentCatalogAgent, currentModel)
      : model.kind.currentValue
  return snapshot.map((descriptor) =>
    descriptor === model
      ? {
          ...descriptor,
          kind: { ...descriptor.kind, type: 'select' as const, choices, currentValue }
        }
      : descriptor
  )
}

export function filterSwitchableModelChoices(
  choices: readonly SessionOptionSelectChoice[],
  query: string
): SessionOptionSelectChoice[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) {
    return [...choices]
  }
  return choices.filter((choice) =>
    [choice.label, choice.description, choice.group, choice.value].some((part) =>
      part?.toLowerCase().includes(needle)
    )
  )
}

export function isCrossProviderStructuredModelChoice(
  currentAgent: AgentType,
  value: string
): { agent: StructuredSwitchableAgent; modelId: string } | null {
  const parsed = parseStructuredModelChoice(value)
  if (!parsed) {
    return null
  }
  if (acpHandleProvider(parsed.agent) === acpHandleProvider(currentAgent)) {
    return null
  }
  return parsed
}
