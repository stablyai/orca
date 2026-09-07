import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'

export async function preflightAgentTrust(args: {
  agent: TuiAgent | null | undefined
  workspacePath: string
  connectionId?: string | null
}): Promise<void> {
  // Trust-gated agents consume the first bracketed paste as menu input.
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  const preset = TUI_AGENT_CONFIG[args.agent].preflightTrust
  if (!preset) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best effort: the user can still dismiss the trust prompt manually.
  }
}
