import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

// Why: CLI-backed usage bars are surface noise when the underlying
// CLI isn't installed (e.g. a fresh Ubuntu install showing "Gemini Usage"
// when no Gemini CLI is on PATH). We hide both the bar and its toggle when
// PATH detection reports the agent as missing. Pre-detection (null) keeps
// the legacy behavior so the bar/toggle don't flicker on cold start, and
// re-show automatically once the agent appears on PATH.
// Why: Record, not Set — 'factory' maps to the droid agent rather than its own id.
const AGENT_GATED_ITEMS: Partial<Record<StatusBarItem, TuiAgent>> = {
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  kimi: 'kimi',
  antigravity: 'antigravity',
  grok: 'grok',
  factory: 'droid'
}

export function isStatusBarItemAvailable(
  id: StatusBarItem,
  detectedAgentIds: TuiAgent[] | null
): boolean {
  const requiredAgent = AGENT_GATED_ITEMS[id]
  if (!requiredAgent) {
    return true
  }
  if (detectedAgentIds === null) {
    return true
  }
  return detectedAgentIds.includes(requiredAgent)
}
