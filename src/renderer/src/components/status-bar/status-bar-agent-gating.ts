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
// host with no `agy` on this machine's PATH. A named credential source is proof we found a
// sign-in somewhere, which is what makes the slot useful — keying on `ok` instead would hide the
// bar the moment that sign-in expires or its host drops, burying the very message that says so.
export function isAntigravityStatusBarAvailable(
  detectedAgentIds: TuiAgent[] | null,
  antigravity: Pick<ProviderRateLimits, 'usageMetadata'> | null | undefined
): boolean {
  return (
    isStatusBarItemAvailable('antigravity', detectedAgentIds) ||
    Boolean(antigravity?.usageMetadata?.credentialSource)
  )
}
