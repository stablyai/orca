import type { AgentProcessPresence } from '../../../shared/agent-process-presence'
import { isLegacyUnidentified } from './legacy-unidentified-agent-presence'

/** Terminal signals may ask the host about the exact live owner; they never end it themselves.
 *  Returns whether the pane has one, so callers skip the legacy guess. */
export function requestAgentOwnerCheck(
  paneKey: string,
  presence: AgentProcessPresence | undefined
): boolean {
  if (!presence?.process || isLegacyUnidentified(presence)) {
    return false
  }
  void window.api?.agentStatus
    ?.checkAgentPresence?.(paneKey, presence.process)
    ?.catch((error: unknown) => console.warn('[agent-presence] owner check failed:', error))
  return true
}
