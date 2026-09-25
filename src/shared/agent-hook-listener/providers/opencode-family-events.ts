import { continueMainAgentStatus } from '../../agent-lead-status-fold'
import {
  normalizeAgentStatusPayload,
  type AgentMainAgentStatus,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { AgentJournalTurnOutcome } from '../../agent-turn-outcome'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'

/** The plugin forwards only a root session's own error name, and only after that turn ended. */
function openCodeRootTurnOutcome(errorName: unknown): AgentJournalTurnOutcome | undefined {
  if (typeof errorName !== 'string' || errorName === '') {
    return undefined
  }
  return errorName === 'MessageAbortedError' ? 'cancellation' : 'failure'
}

/** The root session's own state, carried beside the plugin's pane fold. A plugin that predates
 *  `root_state` gets no main-agent record, so the host never infers one from the fold. */
function resolveOpenCodeMainAgent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): AgentMainAgentStatus | undefined {
  const isSessionStart = eventName === 'SessionStart'
  if (isSessionStart) {
    // Why: a new root session is a new main agent, so its clock restarts.
    state.openCodeMainAgentStatusByPaneKey.delete(paneKey)
  }
  const rootState = hookPayload.root_state
  if (rootState !== 'working' && rootState !== 'waiting' && rootState !== 'done') {
    return undefined
  }
  const mainAgent = continueMainAgentStatus(
    state.openCodeMainAgentStatusByPaneKey.get(paneKey),
    isSessionStart
      ? { state: 'done' }
      : {
          state: rootState,
          outcome:
            rootState === 'done'
              ? openCodeRootTurnOutcome(hookPayload.root_turn_error_name)
              : undefined
        },
    Date.now()
  )
  state.openCodeMainAgentStatusByPaneKey.set(paneKey, mainAgent)
  return mainAgent
}

export function normalizeOpenCodeFamilyEvent(
  source: 'opencode' | 'opencode2' | 'mimo-code',
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const resetsTurn =
    isNewTurnEvent(source, eventName) ||
    (eventName === 'MessagePart' && hookPayload.role === 'user')
  const stateName =
    eventName === 'SessionBusy' || eventName === 'MessagePart'
      ? 'working'
      : eventName === 'SessionIdle'
        ? 'done'
        : (source === 'opencode' || source === 'opencode2') && eventName === 'SessionStart'
          ? 'done'
          : eventName === 'PermissionRequest' || eventName === 'AskUserQuestion'
            ? 'waiting'
            : null

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields(source, eventName, hookPayload),
    {
      resetOnNewTurn: resetsTurn
    }
  )
  // Why: mimo-code and the opencode2 binary share the plugin, but their root-state reports are unverified.
  const mainAgent =
    source === 'opencode'
      ? resolveOpenCodeMainAgent(state, paneKey, eventName, hookPayload)
      : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: resetsTurn
    }),
    agentType: source,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary:
      (source === 'opencode' || source === 'opencode2') && eventName === 'SessionStart'
        ? true
        : undefined,
    // Why: `interrupted` restates the verdict for readers that predate `mainAgent`.
    ...(stateName === 'done' && mainAgent?.outcome === 'cancellation' ? { interrupted: true } : {}),
    ...(mainAgent ? { mainAgent } : {})
  })
}
