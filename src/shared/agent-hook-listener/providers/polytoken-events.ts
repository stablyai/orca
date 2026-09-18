import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Why: Polytoken's question tool lives in its `interaction` group; match any ask-user spelling
// so the pane shows the attention icon instead of a spinner while the model waits on the user.
export function isPolytokenUserInputTool(toolName: string | undefined): boolean {
  return (toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() ?? '').includes('askuser')
}

// Why: `session_start` is identity-only (the listener lands a providerSessionOnly row) and
// `post_model_turn` is fire-and-forget, so it can arrive after the blocking `stop` and would
// flip done back to working; neither maps to a status here.
export function normalizePolytokenEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const isUserInputTool = isPolytokenUserInputTool(readString(hookPayload, 'tool_name'))

  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'pre_user_prompt' ||
    eventName === 'pre_model_turn' ||
    eventName === 'post_tool_use' ||
    eventName === 'post_tool_use_failure' ||
    (eventName === 'pre_tool_use' && !isUserInputTool)
  ) {
    stateName = 'working'
  } else if (eventName === 'pre_tool_use' && isUserInputTool) {
    stateName = 'waiting'
  } else if (eventName === 'stop') {
    stateName = 'done'
  }
  if (!stateName) {
    return null
  }

  const resetOnNewTurn = isNewTurnEvent('polytoken', eventName)
  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('polytoken', eventName, hookPayload),
    { resetOnNewTurn }
  )
  const model = readString(hookPayload, 'model_name')

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, { resetOnNewTurn }),
    agentType: 'polytoken',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(model ? { model } : {})
  })
}
