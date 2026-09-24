import { useAppStore } from '../../store'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'
import { isStatusBarItemAvailable } from './status-bar-agent-gating'
import { isCursorStatusBarAvailable } from './status-bar-provider-visibility'

/** Filters CLI toggles by detection and Cursor by credential or usage state. */
export function useAvailableStatusBarToggles<T extends { id: StatusBarItem }>(
  toggles: readonly T[]
): T[] {
  const detectedAgentIds = useAppStore((s) => s.detectedAgentIds)
  const cursor = useAppStore((s) => s.rateLimits.cursor)
  const cursorAuthConfigured = useAppStore((s) => s.rateLimits.cursorAuthConfigured)
  return toggles.filter((toggle) =>
    toggle.id === 'cursor'
      ? isCursorStatusBarAvailable(cursor, cursorAuthConfigured)
      : isStatusBarItemAvailable(toggle.id, detectedAgentIds)
  )
}
