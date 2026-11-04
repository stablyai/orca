import type { AgentChildWorkKind } from '../../agent-status-child-work'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from '../../agent-status-child-work-liveness'
import { isRecord } from '../../agent-status-child-work-value-guards'
import type { HookListenerState } from '../listener-state'
import { isGrokEvent } from '../provider-event-names'
import { readString } from '../tool-input-preview'
import { getGrokNotificationType } from './grok-tool-fields'

// Grok's own task ids per pane, since StopCancelled carries no inventory. A child session's id is its
// subagent's task id; a finished shell is named only inside its task_complete message.

/** Grok lists only in-flight finite tasks; exclude indefinite monitors so they cannot suppress completion forever. */
export function grokFiniteTaskKind(task: unknown): AgentChildWorkKind | null {
  if (!isRecord(task)) {
    return null
  }
  return task.type === 'subagent' ? 'agent' : task.type === 'shell' ? 'command' : null
}

/** The inventory a Grok turn end reports; Stop carries it, StopCancelled (1.0.70) does not. */
export function readGrokInventory(hookPayload: Record<string, unknown>): unknown[] | undefined {
  const value = Object.hasOwn(hookPayload, 'backgroundTasks')
    ? hookPayload.backgroundTasks
    : hookPayload.background_tasks
  return Array.isArray(value) ? value : undefined
}

function startedShellTaskId(hookPayload: Record<string, unknown>): string | undefined {
  const result = hookPayload.toolResult ?? hookPayload.tool_response
  return isRecord(result) && result.type === 'BackgroundTaskStarted'
    ? readString(result, 'task_id')
    : undefined
}

function addTask(
  state: HookListenerState,
  paneKey: string,
  id: string,
  kind: AgentChildWorkKind
): void {
  const tasks = state.grokBackgroundTasksByPaneKey.get(paneKey) ?? new Map()
  state.grokBackgroundTasksByPaneKey.set(paneKey, tasks.set(id, kind))
}

/** Returns true when a child session the pane was tracking ends. */
export function trackGrokChildSession(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  const sessionId = readString(hookPayload, 'sessionId') ?? readString(hookPayload, 'session_id')
  if (!sessionId) {
    return false
  }
  if (isGrokEvent(eventName, 'user_prompt_submit')) {
    addTask(state, paneKey, sessionId, 'agent')
  }
  return (
    isGrokEvent(eventName, 'session_end') &&
    state.grokBackgroundTasksByPaneKey.get(paneKey)?.delete(sessionId) === true
  )
}

export function trackGrokMainTasks(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): void {
  const inventory = isGrokEvent(eventName, 'stop', 'stop_failure', 'stop_cancelled')
    ? readGrokInventory(hookPayload)
    : undefined
  if (inventory) {
    state.grokBackgroundTasksByPaneKey.delete(paneKey)
    for (const task of inventory) {
      const kind = grokFiniteTaskKind(task)
      const id = isRecord(task) ? readString(task, 'id') : undefined
      if (kind && id) {
        addTask(state, paneKey, id, kind)
      }
    }
    return
  }
  const shellId = isGrokEvent(eventName, 'post_tool_use')
    ? startedShellTaskId(hookPayload)
    : undefined
  if (shellId) {
    addTask(state, paneKey, shellId, 'command')
    return
  }
  const tasks = state.grokBackgroundTasksByPaneKey.get(paneKey)
  if (
    tasks &&
    isGrokEvent(eventName, 'notification') &&
    isGrokEvent(getGrokNotificationType(hookPayload), 'task_complete')
  ) {
    const message = readString(hookPayload, 'message') ?? ''
    for (const id of tasks.keys()) {
      if (message.includes(id)) {
        tasks.delete(id)
      }
    }
  }
}

export function grokBackgroundTaskLiveness(
  state: HookListenerState,
  paneKey: string
): AgentChildWorkLiveness {
  const tasks = state.grokBackgroundTasksByPaneKey.get(paneKey)
  return agentChildWorkLiveness(Array.from(tasks?.values() ?? [], (kind) => ({ kind })))
}
