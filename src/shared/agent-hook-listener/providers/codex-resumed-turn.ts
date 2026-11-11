import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { sameAgentStatusTerminalOwner } from '../../agent-status/identity/agent-status-terminal-owner'
import { seedCodexStateFromSnapshot } from './codex-state'
import type { ParsedAgentStatusPayload } from '../../agent-status/contracts/agent-status-types'

/** Opening the same conversation must not replace its saved turn with an empty idle boundary. */
export function codexResumedTurn(
  state: HookListenerState,
  event: AgentHookEventPayload,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload | null {
  if (
    event.payload.agentType !== 'codex' ||
    event.hookEventName !== 'SessionStart' ||
    event.hasExplicitPrompt ||
    event.toolAgentId !== undefined ||
    event.providerSessionOnly ||
    event.payload.sessionBoundary !== true ||
    event.payload.state !== 'done' ||
    event.payload.prompt.length !== 0 ||
    previous?.payload.agentType !== 'codex' ||
    previous.providerSessionOnly ||
    (previous.payload.state !== 'done' && (!previous.restoredUnconfirmed || event.isReplay)) ||
    !previous.providerSession?.id ||
    previous.providerSession.id !== event.providerSession?.id ||
    !sameAgentStatusTerminalOwner(previous, event)
  ) {
    return null
  }
  // A resumed idle process proves no outcome for work last observed in an earlier runtime.
  const payload: ParsedAgentStatusPayload =
    previous.payload.state === 'done'
      ? { ...previous.payload, model: event.payload.model ?? previous.payload.model }
      : {
          state: 'done',
          agentType: 'codex',
          prompt: previous.payload.prompt,
          model: event.payload.model ?? previous.payload.model,
          lastAssistantMessage: previous.payload.lastAssistantMessage,
          mainAgent:
            previous.payload.mainAgent?.state === 'done'
              ? previous.payload.mainAgent
              : { state: 'done', outcome: 'unconfirmed', stateStartedAt: Date.now() }
        }
  state.codexLeadStateByPaneKey.delete(event.paneKey)
  seedCodexStateFromSnapshot(state, event.paneKey, payload)
  state.lastPromptByPaneKey.set(event.paneKey, payload.prompt)
  state.lastToolByPaneKey.set(event.paneKey, {
    lastAssistantMessage: payload.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: payload.lastAssistantMessageIsToolOutput
  })
  return { ...event, payload }
}
