import type { TuiAgent } from '../../../shared/types'
import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'

export async function markBackgroundAgentWorkspaceTrusted(
  agent: TuiAgent,
  workspacePath: string
): Promise<void> {
  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preflight || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({ preset: preflight, workspacePath })
  } catch {
    // Why: trust preflight is a compatibility convenience; the agent can still
    // start and present its own trust prompt when the artifact write fails.
  }
}
