import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/types'

export async function markDirectLaunchAgentTrusted(
  agent: TuiAgent | null,
  workspacePath: string | null | undefined,
  connectionId: string | null | undefined
): Promise<void> {
  if (!agent || !workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }

  const preflight = TUI_AGENT_CONFIG[agent].preflightTrust
  if (!preflight) {
    return
  }

  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath,
      ...(connectionId ? { connectionId } : {})
    })
  } catch {
    // Best-effort: continue with launch even if the trust write throws. The
    // user can dismiss the trust menu manually.
  }
}
