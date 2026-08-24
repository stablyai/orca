import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'

/** Provider-owned session id (Claude/Codex `session_id`, Antigravity `conversation_id`)
 *  the pane's agent reported, or null when no agent has claimed the pane yet. */
export function readPaneAgentSessionId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  tabId: string,
  leafId: string
): string | null {
  return agentStatusByPaneKey[makePaneKey(tabId, leafId)]?.providerSession?.id?.trim() || null
}

export type CopyAgentSessionIdOutcome = 'copied' | 'unavailable' | 'copy-failed'

/** Why: separates "the agent never reported a session" from a rejected clipboard
 *  write, so the caller can toast the accurate reason instead of one vague error. */
export async function copyPaneAgentSessionId(args: {
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  tabId: string
  leafId: string
  writeClipboardText: (text: string) => Promise<void>
}): Promise<CopyAgentSessionIdOutcome> {
  const sessionId = readPaneAgentSessionId(args.agentStatusByPaneKey, args.tabId, args.leafId)
  if (!sessionId) {
    return 'unavailable'
  }
  try {
    await args.writeClipboardText(sessionId)
    return 'copied'
  } catch {
    return 'copy-failed'
  }
}
