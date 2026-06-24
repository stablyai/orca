import type { ContextualTourId } from './contextual-tours'
import type { FeatureInteractionId } from './feature-interactions'

export const CONTEXTUAL_TOUR_FEATURE_INTERACTION_BY_ID = {
  'workspace-board': 'workspace-board',
  'workspace-agent-sessions': 'workspace-agent-sessions',
  browser: 'browser',
  tasks: 'tasks',
  automations: 'automations',
  'floating-workspace': 'floating-workspace',
  'workspace-creation': 'workspace-creation',
  'folder-workspace-create-callout': null,
  'folder-workspace-creation': 'folder-workspace-creation',
  'folder-workspace-overview': 'folder-workspace-right-sidebar'
} as const satisfies Record<ContextualTourId, FeatureInteractionId | null>

export function getFeatureInteractionIdForContextualTour(
  id: ContextualTourId
): FeatureInteractionId | null {
  return CONTEXTUAL_TOUR_FEATURE_INTERACTION_BY_ID[id]
}
