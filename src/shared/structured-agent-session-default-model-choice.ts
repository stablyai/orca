import type { SessionOptionDescriptor } from './native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

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
