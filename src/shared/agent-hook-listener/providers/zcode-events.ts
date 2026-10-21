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

// Why: ZCode's own lifecycle events are camelCase, but its hook runner writes a
// Claude-compatible stdin alias set (`hook_event_name`, `tool_name`, `tool_input`,
// `transcript_path`, `last_assistant_message`) alongside them — see ZCode's
// `packages/core/src/hooks/configured-runner-input.ts`. Orca reads the aliases, so the
// Claude tool-field extractor applies verbatim; only the agent identity differs.
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

/** What one ZCode lifecycle event says about the pane, or null when it says nothing. */
function readZCodeTurn(eventName: unknown, hookPayload: Record<string, unknown>): ZCodeTurn | null {
  switch (eventName) {
    case 'SessionStart': {
      // Why: land a resumed/started session as an idle boundary row, not a phantom spinner;
      // `compact` fires mid-turn, so anything outside the idle allowlist is dropped.
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
      // Why: ZCode's clarification tool is literally `AskUserQuestion` with Claude's
      // questions/options input shape, so Orca's question card renders it unchanged.
      return {
        stateName: isAskUserQuestionTool(readString(hookPayload, 'tool_name'))
          ? 'waiting'
          : 'working'
      }
    // Why: ZCode fires this only once the approval card is already on screen and racing the
    // user's answer (`packages/core/src/tool/executor/permission-flow.ts`), never for an
    // auto-approved call — so it is proof the pane is blocked on a human.
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
