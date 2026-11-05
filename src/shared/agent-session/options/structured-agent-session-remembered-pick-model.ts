import {
  structuredAgentSessionDescribedModel,
  structuredAgentSessionShownModel
} from './structured-agent-session-option-snapshot'
import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'

/** The model a pick is remembered under: a model pick's own, else the one its values were chosen under
 *  (the chat's own, else the default shown). A chat on the resolved id it ran keeps the new-chat model:
 *  its picks join the listed row that runs it and never adopt a model, so that id never becomes a default. */
export function structuredAgentSessionRememberedPickModel(
  state: StructuredAgentSessionOptionState,
  committedModel: string | undefined
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
  const listed = structuredAgentSessionDescribedModel(state, controlsModelId)
  return listed && listed.id !== controlsModelId
    ? { modelId: listed.id, adoptModelAsLaunchDefault: false }
    : { modelId: controlsModelId }
}
