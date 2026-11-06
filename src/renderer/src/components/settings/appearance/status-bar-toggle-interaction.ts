import type { FeatureInteractionId } from '../../../../../shared/feature-interaction-catalog'
import type { StatusBarItem } from '../../../../../shared/ui-chrome-types'

// Why: an exhaustive map makes new status bar items pick their feature explicitly.
const STATUS_BAR_TOGGLE_FEATURE: Record<StatusBarItem, FeatureInteractionId | null> = {
  'resource-usage': 'resource-manager',
  ports: 'ports',
  ssh: 'ssh',
  claude: 'usage-tracking',
  codex: 'usage-tracking',
  gemini: 'usage-tracking',
  'opencode-go': 'usage-tracking',
  kimi: 'usage-tracking',
  antigravity: 'usage-tracking',
  minimax: 'usage-tracking',
  grok: 'usage-tracking',
  cursor: 'usage-tracking',
  zcode: null
}

export function recordStatusBarToggleInteraction(
  id: StatusBarItem,
  recordFeatureInteraction: (feature: FeatureInteractionId) => void
): void {
  const feature = STATUS_BAR_TOGGLE_FEATURE[id]
  if (feature) {
    recordFeatureInteraction(feature)
  }
}
