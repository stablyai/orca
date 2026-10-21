import { resolvePaneAgentSessionId, type PaneAgentSessionIdState } from './pane-agent-session-id'

// Preview staging requires live routing authority, never a cached title or launch hint.
export function terminalImageAttachmentScope(
  state: PaneAgentSessionIdState,
  paneKey: string,
  ptyId: string | null
): string | null {
  const foreground = state.paneForegroundAgentByPaneKey[paneKey]
  if (
    !ptyId ||
    foreground?.agent !== 'codex' ||
    foreground.routingTrusted !== true ||
    foreground.routingRevoked === true ||
    foreground.shellForeground
  ) {
    return null
  }
  return `${ptyId}:${resolvePaneAgentSessionId(state, paneKey) ?? ''}`
}
