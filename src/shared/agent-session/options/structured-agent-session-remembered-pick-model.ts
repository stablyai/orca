import {
  structuredAgentSessionDescribedModel,
  structuredAgentSessionShownModel
} from './structured-agent-session-option-snapshot'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

/** The model a pick is remembered under: a model pick's own, else the one its values were chosen under
 *  (the chat's own, else the default shown, joined to the listed row that runs it). Only a new chat's
 *  value picks adopt that model as the new-chat default; an existing chat's keep the remembered model. */
export function structuredAgentSessionRememberedPickModel(
  state: StructuredAgentSessionOptionState,
  committedModel: string | undefined,
  existingChat: boolean
): { modelId: string; adoptModelAsLaunchDefault?: false } | null {
  if (typeof committedModel === 'string' && committedModel.trim()) {
    return { modelId: committedModel }
  }
  const controlsModelId = state.catalog
    ? structuredAgentSessionShownModel(state.catalog, state.catalog.models, state.record)
        .controlsModelId
    : null
  if (!controlsModelId) {
    return null
  }
  const modelId =
    structuredAgentSessionDescribedModel(state, controlsModelId)?.id ?? controlsModelId
  return existingChat ? { modelId, adoptModelAsLaunchDefault: false } : { modelId }
}
