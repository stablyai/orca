import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { StatusBarItem } from '../../../../shared/ui-chrome-types'

// Why: CLI-backed usage bars are surface noise when the underlying
// CLI isn't installed (e.g. a fresh Ubuntu install showing "Gemini Usage"
// when no Gemini CLI is on PATH). We hide both the bar and its toggle when
// PATH detection reports the agent as missing. Pre-detection (null) keeps
// the legacy behavior so the bar/toggle don't flicker on cold start, and
// re-show automatically once the agent appears on PATH.
const CLI_GATED_ITEMS: ReadonlySet<StatusBarItem> = new Set([
  'claude',
  'codex',
  'gemini',
  'kimi',
  'antigravity',
  'grok'
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

// Why: Antigravity is read from a credential, so it can be signed in only on a remote execution
// host with no `agy` on this machine's PATH. A snapshot that actually carries quota is its own
// proof the slot is useful; PATH detection alone would hide the bar in exactly that case.
export function isAntigravityStatusBarAvailable(
  detectedAgentIds: TuiAgent[] | null,
  antigravity: Pick<ProviderRateLimits, 'status'> | null | undefined
): boolean {
  return isStatusBarItemAvailable('antigravity', detectedAgentIds) || antigravity?.status === 'ok'
}
