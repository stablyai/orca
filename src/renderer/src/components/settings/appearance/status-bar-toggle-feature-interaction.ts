import type { StatusBarItem } from '../../../../../shared/ui-chrome/ui-chrome-types'
import type { FeatureInteractionId } from '../../../../../shared/feature-education/interactions/feature-interaction-catalog'

export function recordStatusBarToggleInteraction(
  id: StatusBarItem,
  recordFeatureInteraction: (feature: FeatureInteractionId) => void
): void {
  if (id === 'resource-usage') {
    recordFeatureInteraction('resource-manager')
  } else if (id === 'ports') {
    recordFeatureInteraction('ports')
  } else if (id === 'ssh') {
    recordFeatureInteraction('ssh')
  } else if (
    id === 'claude' ||
    id === 'codex' ||
    id === 'opencode-go' ||
    id === 'kimi' ||
    id === 'minimax' ||
    id === 'grok' ||
    id === 'cursor' ||
    id === 'muse'
  ) {
    recordFeatureInteraction('usage-tracking')
  }
}
