import { parsePaneKey } from './stable-pane-id'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from './structured-agent-session-projection'

/** Only canonical notification keys encode conversation identity; surface IDs do not. */
export function structuredSessionIdFromNotificationPane(paneKey: string): string | null {
  const pane = parsePaneKey(paneKey)
  const prefix = 'structured-agent-session-'
  if (!pane?.tabId.startsWith(prefix)) {
    return null
  }
  const sessionId = pane.tabId.slice(prefix.length)
  return sessionId.length > 0 &&
    sessionId.length <= 256 &&
    structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId) === paneKey
    ? sessionId
    : null
}
