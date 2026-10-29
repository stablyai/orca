import type { TuiAgent } from '../../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

// Native flag/env prefill intentionally skips paste unless forcePaste is set; false then means delivered natively, not paste failure.
export function agentDeliversDraftViaNativePrefill(
  agent: TuiAgent | undefined,
  forcePaste: boolean | undefined
): boolean {
  if (forcePaste) {
    return false
  }
  const agentConfig = agent ? TUI_AGENT_CONFIG[agent] : null
  return Boolean(agentConfig?.draftPromptFlag || agentConfig?.draftPromptEnvVar)
}
