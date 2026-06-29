import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import { resolveTuiAgentBaseAgent } from '../../../shared/tui-agent-profiles'
import type { TuiAgent, TuiAgentProfile } from '../../../shared/types'

export async function markBackgroundAgentWorkspaceTrusted(args: {
  agent: TuiAgent
  agentProfiles: readonly TuiAgentProfile[]
  workspacePath: string | null | undefined
}): Promise<void> {
  const baseAgent = resolveTuiAgentBaseAgent(args.agent, args.agentProfiles)
  const preflight = baseAgent ? TUI_AGENT_CONFIG[baseAgent].preflightTrust : undefined
  if (!preflight || !args.workspacePath || !window.api.agentTrust?.markTrusted) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath
    })
  } catch {
    // Best-effort: continue with launch. The user can still accept the trust menu.
  }
}
