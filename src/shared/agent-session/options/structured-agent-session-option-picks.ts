import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from '../../native-chat/input/session-options/native-chat-session-option-defaults'
import type { SessionOptionValue } from '../../native-chat/input/native-chat-session-options'
import { structuredAgentSessionRememberedPickModel } from './selection/structured-agent-session-remembered-pick-model'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './selection/structured-agent-session-option-codec'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
  adoptModelAsLaunchDefault?: boolean
}

/** Reseedable ids only. Effort-only picks adopt the model launch already stored. */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>,
  existingChat = false
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
      : [{ ...remembered, optionId, value: decoded }]
  })
}
