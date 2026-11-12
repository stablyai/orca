import { isCachedJcodeHelperSession } from '../../jcode-helper-sessions'
import type { ParsedHookEnvelope } from '../hook-envelope'
import type { AgentHookEventPayload } from '../listener-event'
import type { HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'
import type { AgentHookSource } from '../transport/agent-hook-relay'
import { extractJcodeToolFields, isJcodeUserInputTool } from './jcode-tool-fields'

type HelperRequest = { toolInput?: string; interactivePrompt?: string }

export type JcodeHelperPermissionWait = {
  /** Open request_permission questions by helper session, oldest first. */
  requests: Map<string, HelperRequest>
  /** The pane's status before the first open request, restored once every request settles. */
  before: AgentHookEventPayload['payload']
  /** The question the row shows; any other row means the main agent has moved on. */
  shown: string | undefined
}

/** Jcode fires every swarm session's hooks with the requesting pane's key, so a helper's hooks must
 *  not drive the pane's row (the verdict is read ahead by the hook owner preflight). A helper's
 *  request_permission still blocks on the user, so it shows the row as waiting until it settles.
 *  Returns undefined for hooks that are not a helper's. */
export function routeJcodeHelperHook(
  state: HookListenerState,
  source: AgentHookSource,
  { paneKey, eventName, hookPayloadRecord: hookPayload, launchToken }: ParsedHookEnvelope,
  committedRows: ReadonlyMap<string, AgentHookEventPayload> | undefined
): AgentHookEventPayload | null | undefined {
  const sessionId = source === 'jcode' ? readString(hookPayload, 'session_id') : undefined
  if (!sessionId || !isCachedJcodeHelperSession(sessionId)) {
    return undefined
  }
  // A relay's provider view lags its committed rows; restate the committed one.
  const row = (committedRows ?? state.lastStatusByPaneKey).get(paneKey)
  // A helper left over from an earlier launch speaks for no current row.
  if (
    row?.payload.agentType !== 'jcode' ||
    (launchToken && row.launchToken && launchToken !== row.launchToken)
  ) {
    return null
  }
  const waits = state.jcodeHelperPermissionWaitByPaneKey
  const saved = waits.get(paneKey)
  const wait =
    saved &&
    row.payload.state === 'waiting' &&
    row.payload.toolName === 'request_permission' &&
    row.payload.interactivePrompt === saved.shown
      ? saved
      : undefined
  if (saved && !wait) {
    waits.delete(paneKey)
  }
  const toolName = readString(hookPayload, 'tool_name')
  if (eventName === 'pre_tool' && isJcodeUserInputTool(toolName)) {
    const { toolInput, interactivePrompt } = extractJcodeToolFields(eventName, hookPayload)
    const requests = new Map(wait?.requests)
    requests.delete(sessionId)
    requests.set(sessionId, { toolInput, interactivePrompt })
    waits.set(paneKey, { requests, before: wait?.before ?? row.payload, shown: interactivePrompt })
    const payload = {
      ...row.payload,
      state: 'waiting' as const,
      toolName,
      toolInput,
      interactivePrompt
    }
    return restate(row, payload, 'pre_tool')
  }
  const settles =
    (eventName === 'post_tool' && isJcodeUserInputTool(toolName)) ||
    eventName === 'turn_end' ||
    eventName === 'session_end'
  if (!wait || !settles || !wait.requests.delete(sessionId)) {
    return null
  }
  const next = [...wait.requests.values()].at(-1)
  if (next) {
    wait.shown = next.interactivePrompt
    return restate(row, { ...row.payload, ...next }, 'pre_tool')
  }
  waits.delete(paneKey)
  const { before } = wait
  // A rested row settles as a boundary so the answer does not read as a second finished turn.
  return restate(row, before.state === 'done' ? { ...before, sessionBoundary: true } : before)
}

/** The pane's row with new status; without an event name it neither replays nor notifies. */
function restate(
  row: AgentHookEventPayload,
  payload: AgentHookEventPayload['payload'],
  hookEventName?: string
): AgentHookEventPayload {
  return { ...row, isReplay: undefined, hasExplicitPrompt: undefined, hookEventName, payload }
}
