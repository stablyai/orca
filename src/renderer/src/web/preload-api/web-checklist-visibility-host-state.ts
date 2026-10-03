import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type { PairedUiState } from '../../../../shared/pairing-local-ui-fields'
import type { ChecklistVisibilityObservation } from './web-checklist-visibility-revision'
import { acceptChecklistVisibilityObservation } from './web-checklist-visibility-revision'
import {
  mergeContextualTourSeenIds,
  mergeFeatureInteractionState,
  mergeHostWebUIState,
  mergeOsc52ClipboardNoticePending
} from './web-preference-normalization'

export function mergeObservedHostUIState(
  local: PersistedUIState,
  host: PairedUiState,
  observation: ChecklistVisibilityObservation
): PersistedUIState {
  const checklistObserved = acceptChecklistVisibilityObservation(
    observation,
    host.setupGuideSettingsDismissed
  )
  return {
    ...mergeHostWebUIState(local, host),
    osc52ClipboardDefaultOnNoticePending: mergeOsc52ClipboardNoticePending(local, host),
    featureInteractions: mergeFeatureInteractionState(
      local.featureInteractions,
      host.featureInteractions
    ),
    contextualToursSeenIds: mergeContextualTourSeenIds(
      local.contextualToursSeenIds,
      host.contextualToursSeenIds
    ),
    ...(checklistObserved ? {} : { setupGuideSettingsDismissed: local.setupGuideSettingsDismissed })
  }
}
