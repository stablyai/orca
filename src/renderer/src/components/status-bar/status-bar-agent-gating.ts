import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

// Hide missing CLI items and toggles after detection; unknown detection preserves them to avoid cold-start flicker.
const CLI_GATED_ITEMS: ReadonlySet<StatusBarItem> = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi',
  'antigravity',
  'grok',
  'zcode'
])

export function isStatusBarItemAvailable(
  id: StatusBarItem,
  detectedAgentIds: TuiAgent[] | null
): boolean {
  if (!CLI_GATED_ITEMS.has(id)) {
    return true
  }
  if (detectedAgentIds === null) {
    return true
  }
  return detectedAgentIds.includes(id as TuiAgent)
}
