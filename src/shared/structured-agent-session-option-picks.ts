// Only per-model picks become launch defaults; permission choices belong to each chat.

import { STRUCTURED_LAUNCH_SEED_OPTION_IDS } from './native-chat-session-option-defaults'
import type { SessionOptionValue } from './native-chat-session-options'
import { resolveEffectiveNativeChatModelId } from './native-chat-session-option-snapshot'
import {
  decodeStructuredAgentSessionOptionValue,
  encodeStructuredAgentSessionOptionValue
} from './structured-agent-session-option-codec'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

export type StructuredSessionOptionPick = {
  modelId: string
  optionId: string
  value: SessionOptionValue
}

/** Committed model and effort travel together so launch defaults survive an effort-only pick. */
export function structuredAgentSessionOptionPicks(
  state: StructuredAgentSessionOptionState,
  committed: Readonly<Record<string, string>>
): StructuredSessionOptionPick[] {
  if (!state.catalog) {
    return []
  }
  const committedModel = committed.model
  const modelId =
    typeof committedModel === 'string' && committedModel.trim()
      ? committedModel
      : resolveEffectiveNativeChatModelId(state.catalog, state.catalog.models, state.record)
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
      : [{ modelId, optionId, value: decoded }]
  })
}
