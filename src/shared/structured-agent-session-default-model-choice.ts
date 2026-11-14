import { withTrackedNativeChatModel } from './native-chat/input/session-options/native-chat-session-option-snapshot'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice
} from './native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from './agent-session/options/structured-agent-session-options'

export function structuredAgentSessionDefaultModelChoice(
  state: StructuredAgentSessionOptionState
): NonNullable<SessionOptionDescriptor['defaultChoice']> {
  const model = state.defaultModel
  return {
    selected: state.modelDefault === true,
    ...(model
      ? {
          model: {
            value: model.id,
            label: model.label,
            ...(model.description ? { description: model.description } : {})
          }
        }
      : {})
  }
}

export function structuredAgentSessionReportedModelChoice(
  state: StructuredAgentSessionOptionState
): SessionOptionSelectChoice | undefined {
  const id = state.modelDefault ? state.reportedModel : undefined
  const catalog = state.catalog
  if (!id || !catalog) {
    return undefined
  }
  const model = withTrackedNativeChatModel(catalog, catalog.models, {
    model: { value: id, source: 'reported' }
  }).find((model) => model.id === id)
  return { value: id, label: model?.label ?? id }
}
