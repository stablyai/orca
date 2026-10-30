import type { AgentHookSource } from '../agent-hook-relay'
import { readAgentEffortLevel } from '../agent-effort-level'
import {
  extractAgentProviderSession,
  readPathFromKeys,
  type AgentProviderSessionMetadata
} from '../agent-session-resume'
import type { HookListenerState } from './listener-state'
import { isGrokSubagentEvent } from './providers/grok-tool-fields'
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
  if (source === 'grok' && isGrokSubagentEvent(hookPayload)) {
    // A Grok child's session id is its own; the only child row it emits restates the pane's session.
    const previous = state.lastStatusByPaneKey.get(paneKey)
    return previous?.source === 'grok' ? (previous.providerSession ?? null) : null
  }
  const providerSession = extractAgentProviderSession(
    source,
    source === 'hermes' ? withHermesPaneSessionId(state, paneKey, hookPayload) : hookPayload
  )
  if (!providerSession) {
    return null
  }
  const continued = continuedProviderSession(
    state,
    source,
    paneKey,
    providerSession.id,
    hookPayload
  )
  const cwd = readAgentCwd(source, hookPayload, continued)
  const effort = readClaudeEffort(source, hookPayload, continued)
  return {
    ...providerSession,
    ...(cwd ? { cwd } : {}),
    ...(effort ? { effort } : {})
  }
}

/** The pane's previous session when this hook continues it; /clear and compact restart Claude in the same process. */
function continuedProviderSession(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  sessionId: string,
  hookPayload: Record<string, unknown>
): AgentProviderSessionMetadata | undefined {
  const previous = state.lastStatusByPaneKey.get(paneKey)
  const continues =
    previous?.providerSession?.id === sessionId ||
    (source === 'claude' &&
      hookPayload.hook_event_name === 'SessionStart' &&
      (hookPayload.source === 'clear' || hookPayload.source === 'compact'))
  return previous?.source === source && continues ? previous.providerSession : undefined
}

/** The folder the pane's agent started in. Only Claude/Codex hooks are known to report it (Cursor's cwd is a shell command's). */
function readAgentCwd(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  continued: AgentProviderSessionMetadata | undefined
): string | undefined {
  if (source !== 'claude' && source !== 'codex') {
    return undefined
  }
  // Claude's hook cwd follows its Bash tool's `cd`.
  return continued?.cwd ?? readPathFromKeys(hookPayload, ['cwd'])
}

/** Claude 2.1.133+ reports `effort.level` on tool and Stop hooks only, so other events keep the last one. */
function readClaudeEffort(
  source: AgentHookSource,
  hookPayload: Record<string, unknown>,
  continued: AgentProviderSessionMetadata | undefined
): string | undefined {
  if (source !== 'claude') {
    return undefined
  }
  const effort = hookPayload.effort
  // Why skip subagents: their hooks name the parent session but report the subagent's own effort.
  const reported =
    typeof effort === 'object' &&
    effort !== null &&
    'level' in effort &&
    !readString(hookPayload, 'agent_id')
      ? readAgentEffortLevel(effort.level)
      : undefined
  return reported ?? continued?.effort
}
