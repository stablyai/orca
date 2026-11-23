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
    agent: state.record.agent,
    model: { value: id, source: 'reported' }
  }).find((model) => model.id === id)
  return { value: id, label: model?.label ?? id }
}

/** A Default chat's pill names what its child reports running; the selection stays Default. */
export function withStructuredAgentSessionReportedModel(
  option: SessionOptionDescriptor,
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor {
  const reported =
    option.id === 'model' ? structuredAgentSessionReportedModelChoice(state) : undefined
  return reported
    ? { ...option, reportedModel: reported.value, reportedModelLabel: reported.label }
    : option
}
