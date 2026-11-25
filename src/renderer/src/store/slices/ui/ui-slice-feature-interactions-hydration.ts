import type { PersistedUIState } from '../../../../../shared/orca-profiles/persisted-ui-state-types'
import {
  hasFeatureInteraction,
  normalizeFeatureInteractions,
  type FeatureInteractionState
} from '../../../../../shared/feature-education/interactions/feature-interactions'

export function hydrateFeatureInteractions(
  workspaceBoardUsedBeforeLaunch: boolean | null,
  ui: PersistedUIState
): {
  featureInteractions: FeatureInteractionState
  workspaceBoardUsedBeforeLaunch: boolean
} {
  const featureInteractions = normalizeFeatureInteractions(ui.featureInteractions)
  return {
    featureInteractions,
    // Why: decided once from the first loaded profile, so board use later in this launch (or a sync from
    // another window) never reads as use at the board's old place.
    workspaceBoardUsedBeforeLaunch:
      workspaceBoardUsedBeforeLaunch ??
      hasFeatureInteraction(featureInteractions, 'workspace-board')
  }
}
