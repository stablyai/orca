import type { StatusBarItem, TuiAgent } from '../../../../shared/types'

// Why: Claude/Codex/Gemini usage bars are surface noise when the underlying
// CLI isn't installed (e.g. a fresh Ubuntu install showing "Gemini Usage"
// when no Gemini CLI is on PATH). We hide both the bar and its toggle when
// PATH detection reports the agent as missing. Pre-detection (null) keeps
// the legacy behavior so the bar/toggle don't flicker on cold start, and
// re-show automatically once the agent appears on PATH.
const CLI_GATED_ITEMS: ReadonlySet<StatusBarItem> = new Set(['claude', 'codex', 'gemini'])

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
