import type { AgentType } from './agent-status-types'
import { sessionOptionValueIsValid } from './agent-session-option-catalog'
import type {
  PersistedNativeChatSessionOptions,
  SessionOptionValue
} from './native-chat-session-options'

export function resolveNativeChatSessionOptionDefaults(
  persisted: PersistedNativeChatSessionOptions | null | undefined,
  agent: AgentType
): Record<string, SessionOptionValue> | undefined {
  const entry = persisted?.[agent]
  // Why: untouched settings must preserve the agent CLI's configured defaults;
  // only a model explicitly selected by the user authorizes launch flags.
  const modelId = typeof entry?.model === 'string' && entry.model.trim() ? entry.model : undefined
  if (!modelId) {
    return undefined
  }
  const values: Record<string, SessionOptionValue> = { model: modelId }
  const storedValues = entry?.valuesByModel?.[modelId]
  if (storedValues && typeof storedValues === 'object') {
    for (const [id, value] of Object.entries(storedValues)) {
      if (sessionOptionValueIsValid(value)) {
        values[id] = value
      }
    }
  }
  return values
}

export function updateNativeChatSessionOptionDefaults(args: {
  persisted: PersistedNativeChatSessionOptions | null | undefined
  agent: AgentType
  modelId: string
  optionId: string
  value: SessionOptionValue
}): PersistedNativeChatSessionOptions {
  const currentAgent = args.persisted?.[args.agent]
  const currentModelValues = currentAgent?.valuesByModel?.[args.modelId] ?? {}
  const valuesByModel = {
    ...currentAgent?.valuesByModel,
    ...(args.optionId === 'model'
      ? {}
      : {
          [args.modelId]: { ...currentModelValues, [args.optionId]: args.value }
        })
  }
  return {
    ...args.persisted,
    [args.agent]: {
      ...currentAgent,
      model: args.optionId === 'model' ? String(args.value) : args.modelId,
      valuesByModel
    }
  }
}
