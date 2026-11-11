import { isCachedJcodeHelperSession } from '../../jcode-helper-sessions'
import type { ParsedHookEnvelope } from '../hook-envelope'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import { extractJcodeToolFields, isJcodeUserInputTool } from './jcode-tool-fields'

export type JcodeHelperPermissionWait = {
  /** Helpers whose request_permission is still open. */
  sessionIds: Set<string>
  /** The pane's row before the first open request, restored once every request settles. */
  before: AgentHookEventPayload
}

/** Jcode fires every swarm session's hooks with the requesting pane's key, so a helper's hooks must
 *  not drive the pane's row (the verdict is read ahead by the hook owner preflight). A helper's
 *  request_permission still blocks on the user, so it shows the row as waiting until it settles.
 *  Returns undefined for hooks that are not a helper's. */
export function routeJcodeHelperHook(
  state: HookListenerState,
  source: AgentHookSource,
  { paneKey, eventName, hookPayloadRecord: hookPayload }: ParsedHookEnvelope,
  committedRows: ReadonlyMap<string, AgentHookEventPayload> | undefined
): AgentHookEventPayload | null | undefined {
  if (source !== 'jcode') {
    return undefined
  }
  const waits = state.jcodeHelperPermissionWaitByPaneKey
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId || !isCachedJcodeHelperSession(sessionId)) {
    // The root's own hook replaces the row, so a restore would overwrite newer state.
    waits.delete(paneKey)
    return undefined
  }
  const wait = waits.get(paneKey)
  const toolName = readString(hookPayload, 'tool_name')
  if (eventName === 'pre_tool' && isJcodeUserInputTool(toolName)) {
    // A relay's provider view lags its committed rows; restate the committed one.
    const row = (committedRows ?? state.lastStatusByPaneKey).get(paneKey)
    if (row?.payload.agentType !== 'jcode') {
      return null
    }
    waits.set(paneKey, {
      sessionIds: new Set([...(wait?.sessionIds ?? []), sessionId]),
      before: wait?.before ?? row
    })
    const { toolInput, interactivePrompt } = extractJcodeToolFields(eventName, hookPayload)
    return {
      ...row,
      isReplay: undefined,
      hasExplicitPrompt: undefined,
      hookEventName: 'pre_tool',
      payload: { ...row.payload, state: 'waiting', toolName, toolInput, interactivePrompt }
    }
  }
  const settles =
    (eventName === 'post_tool' && isJcodeUserInputTool(toolName)) ||
    eventName === 'turn_end' ||
    eventName === 'session_end'
  if (!wait || !settles || !wait.sessionIds.delete(sessionId) || wait.sessionIds.size > 0) {
    return null
  }
  waits.delete(paneKey)
  const { before } = wait
  // No event name or prompt, and a rested row settles as a boundary: no new turn and no second "finished".
  return {
    ...before,
    isReplay: undefined,
    hasExplicitPrompt: undefined,
    hookEventName: undefined,
    payload:
      before.payload.state === 'done'
        ? { ...before.payload, sessionBoundary: true }
        : before.payload
  }
}
