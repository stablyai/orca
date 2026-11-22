import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import { unlistedModelLabel } from '../model-catalog/model-id-label'

export function withFallbackModel(
  option: SessionOptionDescriptor,
  model: string,
  agent: string
): SessionOptionDescriptor {
  const { kind } = option
  if (kind.type !== 'select' || kind.choices.some((choice) => choice.value === model)) {
    return { ...option, fallbackModel: model }
  }
  const choice = { value: model, label: unlistedModelLabel(agent, model), description: model }
  return { ...option, fallbackModel: model, kind: { ...kind, choices: [...kind.choices, choice] } }
}
