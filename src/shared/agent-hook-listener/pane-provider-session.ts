import type { AgentHookSource } from '../agent-hook-relay'
import {
  extractAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../agent-session-resume'
import type { HookListenerState } from './listener-state'
import { withHermesPaneSessionId } from './providers/hermes-events'
import { readString } from './tool-input-preview'

/** The provider session a hook names for its pane; child agents' hooks never name their own. */
export function readPaneProviderSession(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  hookPayload: Record<string, unknown>
): AgentProviderSessionMetadata | null {
  if (source === 'codex' && readString(hookPayload, 'agent_id')) {
    return null
  }
  return extractAgentProviderSession(
    source,
    source === 'hermes' ? withHermesPaneSessionId(state, paneKey, hookPayload) : hookPayload
  )
}
