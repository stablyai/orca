import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import type { SessionOptionValue } from './native-chat/input/native-chat-session-options'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat/input/native-chat-session-option-defaults'
import { structuredAgentSessionShownModel } from './structured-agent-session-option-snapshot'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

/** The model a pick's other values were chosen under: the chat's own, else the default shown. */
function structuredAgentSessionControlsModelId(
  state: StructuredAgentSessionOptionState
): string | null {
  return state.catalog
    ? structuredAgentSessionShownModel(state.catalog, state.catalog.models, state.record)
        .controlsModelId
    : null
}

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
  adoptModelAsLaunchDefault?: boolean
}

/** Persist reconciled model-scoped values; Default stays inherited until an explicit model pick. */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>,
  pickedOptionId?: string
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const committedModel = committed.model
  const modelId =
    typeof committedModel === 'string' && committedModel.trim()
      ? committedModel
      : structuredAgentSessionControlsModelId(state)
  if (!modelId) {
    return []
  }
  return STRUCTURED_LAUNCH_SEED_OPTION_IDS.flatMap((optionId) => {
    const value = committed[optionId]
    if (value === undefined) {
      return []
    }
    const decoded = decodeStructuredAgentSessionOptionValue(optionId, value)
    return decoded === null ||
      (typeof decoded === 'string' && !decoded.trim()) ||
      encodeStructuredAgentSessionOptionValue(optionId, decoded) === null
      ? []
      : [
          {
            modelId,
            optionId,
            value: decoded,
            ...(state.modelDefault && pickedOptionId !== 'model'
              ? { adoptModelAsLaunchDefault: false }
              : {})
          }
        ]
  })
}
