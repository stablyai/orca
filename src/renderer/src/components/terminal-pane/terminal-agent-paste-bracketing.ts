import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { isTuiAgent, TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { PaneForegroundAgentEntry } from '../../store/slices/pane-foreground-agent'
import type { TerminalPasteTextOptions } from './terminal-paste-model'

/** Replay/ConPTY can lose DECSET 2004; unbracketed CR submits an agent’s parked draft. Shell silence cannot distinguish deliberate opt-out from bare cat, so require live agent identity. Verified Windows input-record agents need modified Enter instead. This chooses paste encoding, unlike the stricter keystroke-routing resolvers; downstream sanitizes ESC bytes. */
export function resolveProtectedMultilinePasteOptionsForPane({
  isWindowsClient,
  hostPlatform,
  agentStatusByPaneKey,
  paneForegroundAgentByPaneKey,
  tabId,
  leafId
}: {
  isWindowsClient: boolean
  hostPlatform: NodeJS.Platform
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  tabId: string
  leafId: string
}): TerminalPasteTextOptions | undefined {
  let paneKey: string
  try {
    paneKey = makePaneKey(tabId, leafId)
  } catch {
    // Malformed legacy pane keys must fall back; throwing here escapes the paste handler’s later catch.
    return isWindowsClient ? { forceBracketedPasteForMultiline: true } : undefined
  }
  return resolveProtectedMultilinePasteOptionsForAgentEvidence({
    isWindowsClient,
    hostPlatform,
    foregroundAgent: paneForegroundAgentByPaneKey[paneKey]?.agent,
    entry: agentStatusByPaneKey[paneKey]
  })
}

export function resolveProtectedMultilinePasteOptionsForAgentEvidence({
  isWindowsClient,
  hostPlatform,
  foregroundAgent,
  entry
}: {
  isWindowsClient: boolean
  hostPlatform: NodeJS.Platform
  foregroundAgent: unknown
  entry: AgentStatusEntry | undefined
}): TerminalPasteTextOptions | undefined {
  // Rehydrated rows describe a previous process, not this pane’s current foreground.
  const agent = isTuiAgent(foregroundAgent)
    ? foregroundAgent
    : entry?.restoredUnconfirmed !== true && isTuiAgent(entry?.agentType)
      ? entry.agentType
      : null
  // No OSC 133 leaves shellForeground stale; done/TTL also excludes idle live agents. False negatives submit drafts, while false positives only change paste encoding.
  const windowsInputRecordPasteNewline = agent
    ? TUI_AGENT_CONFIG[agent].windowsInputRecordPasteNewline
    : undefined
  if (hostPlatform === 'win32' && windowsInputRecordPasteNewline) {
    return {
      windowsInputRecordNewline: windowsInputRecordPasteNewline
    }
  }
  return isWindowsClient || agent ? { forceBracketedPasteForMultiline: true } : undefined
}
