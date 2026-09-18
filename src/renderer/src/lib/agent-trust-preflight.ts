import { TUI_AGENT_CONFIG } from '../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../shared/tui-agent'

/** Silent best-effort mark; no prompt is shown. Trust-gated agents consume the
 *  first bracketed paste as menu input, so this runs before any prompt delivery. */
export async function preflightAgentTrust(args: {
  agent: TuiAgent | null | undefined
  /** Folder and prospective workspaces can resolve to no path yet. */
  workspacePath: string | null | undefined
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !args.workspacePath || !window.api.agentTrust?.markTrusted) {
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
