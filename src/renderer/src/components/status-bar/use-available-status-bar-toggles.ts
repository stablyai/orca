import { useAppStore } from '../../store'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'

/** Subscribes to detected-agent state and returns the toggles filtered to
 *  those whose underlying CLI is installed (or pre-detection). */
export function useAvailableStatusBarToggles<T extends { id: StatusBarItem }>(
  toggles: readonly T[]
): T[] {
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const antigravity = useAppStore((s) => s.rateLimits.antigravity)
  return toggles.filter((toggle) =>
    isStatusBarItemAvailable(
      toggle.id,
      detectedAgentIds,
      toggle.id === 'antigravity' ? antigravity : null
    )
  )
}
