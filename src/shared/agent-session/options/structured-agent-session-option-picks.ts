import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from '../../native-chat/input/native-chat-session-option-defaults'
import { structuredAgentSessionRememberedPickModel } from './structured-agent-session-remembered-pick-model'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
  adoptModelAsLaunchDefault?: boolean
}

/** Persist only reseedable IDs, using provider-committed values after reconciliation. Effort-only picks adopt their controls’ model
 * because launch reads effort only under a stored model. Pre-commit state is valid: committed supplies changed model, record supplies unchanged model. */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>,
  existingChat = false,
  pickedOptionId?: string
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const remembered = structuredAgentSessionRememberedPickModel(state, committed.model, existingChat)
  if (!remembered) {
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
            ...remembered,
            optionId,
            value: decoded,
            ...(state.modelDefault && pickedOptionId !== 'model'
              ? { adoptModelAsLaunchDefault: false }
              : {})
          }
        ]
  })
}
