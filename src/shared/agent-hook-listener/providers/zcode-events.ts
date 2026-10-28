import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// ZCode configured-runner-input emits Claude-compatible aliases beside native camelCase; reuse Claude tool fields with ZCode identity.
const ZCODE_IDLE_SESSION_START_SOURCES: ReadonlySet<string> = new Set([
  'startup',
  'resume',
  'clear'
])

type ZCodeTurn = {
  stateName: 'working' | 'waiting' | 'done'
  /** Only SessionStart lands a boundary row, and only for an idle source. */
  sessionBoundary?: true
}

function readZCodeTurn(eventName: unknown, hookPayload: Record<string, unknown>): ZCodeTurn | null {
  switch (eventName) {
    case 'SessionStart': {
      // Only idle SessionStart sources settle; compact remains mid-turn.
      const source = hookPayload['source']
      return typeof source === 'string' && ZCODE_IDLE_SESSION_START_SOURCES.has(source)
        ? { stateName: 'done', sessionBoundary: true }
        : null
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { stateName: 'working' }
    case 'PreToolUse':
      // ZCode AskUserQuestion uses Claude's questions/options shape.
      return {
        stateName: isAskUserQuestionTool(readString(hookPayload, 'tool_name'))
          ? 'waiting'
          : 'working'
      }
    // ZCode emits PermissionRequest only with a displayed human approval, never for auto-approved calls (permission-flow.ts).
    case 'PermissionRequest':
      return { stateName: 'waiting' }
    case 'Stop':
      return { stateName: 'done' }
    default:
      return null
  }
}

export function normalizeZCodeEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }
  const turn = readZCodeTurn(eventName, hookPayload)
  if (!turn) {
    return null
  }

  const resetOnNewTurn = isNewTurnEvent('zcode', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('zcode', eventName, hookPayload),
    { resetOnNewTurn }
  )

  return normalizeAgentStatusPayload({
    state: turn.stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'zcode',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    sessionBoundary: turn.sessionBoundary,
    interrupted: eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined
  })
}
