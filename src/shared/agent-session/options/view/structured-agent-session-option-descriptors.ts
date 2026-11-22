import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import { unlistedModelLabel } from '../model-catalog/model-id-label'

/** The pill and the checked row name the fallback; an unlisted one is named like the agent's listed rows. */
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

/** Presentation only until a launch or fence can carry picks. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[],
  capabilitiesOnly = false
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) =>
    capabilitiesOnly &&
    !['effort', 'serviceTier', 'fastMode', 'contextMode'].includes(descriptor.id)
      ? descriptor
      : { ...descriptor, settable: false, disabledReason: 'available-after-session-start' }
  )
}
