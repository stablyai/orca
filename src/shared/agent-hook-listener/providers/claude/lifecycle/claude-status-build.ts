import {
  normalizeAgentStatusPayload,
  type AgentStatusState,
  type AgentWorkingMode,
  type ParsedAgentStatusPayload
} from '../../../../agent-status/contracts/agent-status-types'
import { claudeRosterToSnapshots } from './claude-subagent-roster'
import { resolvePrompt, resolveToolState } from '../../../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../../../provider-event-routing'
import type { HookListenerState } from '../../../listener-state'
import { mainAgentTurnInterrupted } from '../../../../agent-status/lifecycle/agent-lead-status-fold'
import { claudeMainAgentStatusForPayload } from './claude-roster-state'

export function buildClaudeStatusPayload(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>,
  options: {
    stateName: AgentStatusState
    workingMode?: AgentWorkingMode
    updateToolSnapshot: boolean
    /** A new prompt_id opened the turn on this event, ahead of its prompt event. */
    opensTurn?: boolean
    sessionBoundary?: boolean
    claudeTaskWakeupPending?: ParsedAgentStatusPayload['claudeTaskWakeupPending']
  }
): ParsedAgentStatusPayload | null {
  const newTurn = options.opensTurn === true || isNewTurnEvent('claude', eventName)
  // Roster refreshes read cached tool state without clearing live cards or previews.
  const snapshot = options.updateToolSnapshot
    ? resolveToolState(state, paneKey, extractToolFields('claude', eventName, hookPayload), {
        resetOnNewTurn: newTurn
      })
    : (state.lastToolByPaneKey.get(paneKey) ?? {})

  // Read mainAgent/verdict/turn stamp from one lead record; keep interruption there while child-held rows omit it.
  const mainAgentRecord = state.claudeLeadStateByPaneKey.get(paneKey)
  // Validate directly to avoid hot-path stringify/parse overhead.
  return normalizeAgentStatusPayload({
    state: options.stateName,
    workingMode: options.workingMode,
    claudeTaskWakeupPending: options.claudeTaskWakeupPending,
    // Only lead events reset prompt labels; child refreshes retain them.
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: options.updateToolSnapshot && newTurn
    }),
    agentType: 'claude',
    model: mainAgentRecord?.model,
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted: mainAgentTurnInterrupted(mainAgentRecord),
    sessionBoundary: options.sessionBoundary,
    turnCompletedAt: mainAgentRecord?.turnCompletedAt,
    subagents: claudeRosterToSnapshots(state.claudeSubagentRosterByPaneKey.get(paneKey)),
    // Only a row its background shells hold open names them; a turn in progress does not.
    backgroundCommands:
      options.workingMode === 'monitoring'
        ? state.claudeRunningNonAgentTasksByPaneKey.get(paneKey)
        : undefined,
    mainAgent: mainAgentRecord ? claudeMainAgentStatusForPayload(mainAgentRecord) : undefined
  })
}
