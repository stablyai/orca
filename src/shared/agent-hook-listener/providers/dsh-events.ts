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
import { resolveDshLeadEvent } from './dsh-lead-session'

/**
 * DeepSeek Harness reaches Orca through its own `@deepseek-ai/dsh-hooks-claude-code`
 * bridge, so the payloads are Claude-shaped (`session_id`, `tool_name`, `tool_input`,
 * `tool_use_id`, `prompt`) and the event names are a strict subset of Claude's:
 * SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart and
 * SubagentStop. There is no Notification and no PermissionRequest.
 *
 * That missing pair is why the waiting state is read from the tool instead: DSH asks the
 * user through `ask_user_question` (`@deepseek-ai/dsh-tool-ask-user`), whose PreToolUse
 * fires while the question card owns the screen and whose PostToolUse only lands once the
 * user answers. An approval pause has no hook of its own and reads as `working`, which is
 * the honest answer — the harness is mid-tool, not idle.
 */
export function normalizeDshEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  // Why: child agents post every lifecycle hook under their own session id; only the lead's may
  // drive the pane or become its resume target. Subagent edges only record children.
  const lead = resolveDshLeadEvent(state, paneKey, eventName, promptText, hookPayload)
  if (lead.kind === 'drop') {
    return null
  }
  const effectivePrompt =
    lead.kind === 'adopted' && !promptText && lead.heldPrompt ? lead.heldPrompt : promptText

  const toolName = readString(hookPayload, 'tool_name')

  let stateName: 'working' | 'waiting' | 'done'
  switch (eventName) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      stateName = 'working'
      break
    case 'PreToolUse':
      stateName = isAskUserQuestionTool(toolName) ? 'waiting' : 'working'
      break
    case 'SessionStart':
    case 'Stop':
      stateName = 'done'
      break
    default:
      return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('dsh', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('dsh', eventName) }
  )

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, effectivePrompt, {
      resetOnNewTurn: isNewTurnEvent('dsh', eventName)
    }),
    agentType: 'dsh',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    // Why: SessionStart marks a created, resumed, cleared or compacted session, not a turn end,
    // and tui-idle's hook lane must not settle a booting composer on it.
    sessionBoundary: eventName === 'SessionStart' ? true : undefined
  })
}
