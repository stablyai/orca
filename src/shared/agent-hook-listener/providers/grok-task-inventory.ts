// Grok's per-pane background-task inventory: what Grok last reported running behind the main
// agent, plus each task's own start and end hooks between reports. Kept apart from grok-events so
// the event mapping stays about turn state. Measured against Grok 1.0.41:
// src/shared/__fixtures__/grok-cancel-subagent-dialog-hooks.jsonl and
// grok-background-completion-hooks.jsonl.
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import { foldAgentLeadStatus } from '../../agent-lead-status-fold'
import type { AgentChildWorkKind } from '../../agent-status-child-work'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness,
  type AgentChildWorkLivenessCandidate
} from '../../agent-status-child-work-liveness'
import type { HookListenerState } from '../listener-state'
import { resolvePrompt, resolveToolState } from '../prompt-fields'
import { readString } from '../tool-input-preview'
import { isGrokEvent } from '../provider-event-names'

function aliasedField(
  payload: Record<string, unknown>,
  primary: string,
  alias: string
): { present: boolean; value?: unknown } {
  if (Object.hasOwn(payload, primary)) {
    return { present: true, value: payload[primary] }
  }
  if (Object.hasOwn(payload, alias)) {
    return { present: true, value: payload[alias] }
  }
  return { present: false }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const MAX_GROK_ID_LENGTH = 512

export function grokIdentityField(
  hookPayload: Record<string, unknown>,
  primary: string,
  alias: string
): string | undefined {
  const value = readString(hookPayload, primary) ?? readString(hookPayload, alias)
  return value && value.length <= MAX_GROK_ID_LENGTH ? value : undefined
}

/** A finite `backgroundTasks[]` entry as child work. Grok lists only in-flight tasks, so none
 *  carries a settled state. Monitors are left out: they can run indefinitely and would hold the
 *  pane (and silence its completion) forever. */
function grokFiniteTaskKind(task: unknown): AgentChildWorkKind | null {
  if (!isRecord(task)) {
    return null
  }
  return task.type === 'subagent' ? 'agent' : task.type === 'shell' ? 'command' : null
}

/** A hook that carries the `backgroundTasks` key restates the pane's inventory whole; one without
 *  it (measured: `stop_cancelled`) leaves the last reported inventory standing. */
export function restateGrokTaskInventory(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const backgroundTasks = aliasedField(hookPayload, 'backgroundTasks', 'background_tasks')
  if (!backgroundTasks.present || !Array.isArray(backgroundTasks.value)) {
    return
  }
  const inventory = new Map<string, AgentChildWorkKind>()
  backgroundTasks.value.forEach((task, index) => {
    const kind = grokFiniteTaskKind(task)
    if (!kind) {
      return
    }
    const id = isRecord(task) ? readString(task, 'id') : undefined
    inventory.set(id ?? `unidentified-task-${index}`, kind)
  })
  if (inventory.size === 0) {
    state.grokBackgroundTasksByPaneKey.delete(paneKey)
  } else {
    state.grokBackgroundTasksByPaneKey.set(paneKey, inventory)
  }
}

/** What the turn's end leaves running behind the main agent, from the inventory Grok last
 *  reported. A background subagent is agent work and keeps the pane `working`; a shell, or a
 *  still-active stop hook holding the turn, is watch work and reads as monitoring. */
export function grokChildWorkLivenessAfterTurnEnd(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): AgentChildWorkLiveness {
  const stopHookActive = aliasedField(hookPayload, 'stopHookActive', 'stop_hook_active')
  const candidates: AgentChildWorkLivenessCandidate[] = [
    ...(state.grokBackgroundTasksByPaneKey.get(paneKey)?.values() ?? [])
  ].map((kind) => ({ kind }))
  return agentChildWorkLiveness(candidates) ?? (stopHookActive.value === true ? 'monitoring' : null)
}

// Why: Grok's own literal for its task_complete Notification; the id after it is the task's id.
const GROK_TASK_COMPLETE_MESSAGE_PREFIX = 'Background task completed: '

function addGrokInventoryTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string,
  kind: AgentChildWorkKind
): void {
  const inventory =
    state.grokBackgroundTasksByPaneKey.get(paneKey) ?? new Map<string, AgentChildWorkKind>()
  inventory.set(taskId, kind)
  state.grokBackgroundTasksByPaneKey.set(paneKey, inventory)
}

/** A main-session background shell joins the inventory at its start, so a turn cancelled before
 *  any `stop` restated it still folds with it. Monitors return a different result and stay out. */
export function recordGrokBackgroundTaskStarted(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): void {
  const result = hookPayload.toolResult ?? hookPayload.toolResponse ?? hookPayload.tool_response
  if (!isRecord(result) || result.type !== 'BackgroundTaskStarted' || result.task_type !== 'bash') {
    return
  }
  const taskId = readString(result, 'task_id')
  if (!taskId || taskId.length > MAX_GROK_ID_LENGTH) {
    return
  }
  addGrokInventoryTask(state, paneKey, taskId, 'command')
}

/** Drops a task that reported its own end. When the inventory was all that held a settled row
 *  open, re-derives the row: a cancel suppresses the follow-up turn whose `stop` would. */
function dropGrokFinishedTask(
  state: HookListenerState,
  paneKey: string,
  taskId: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const inventory = state.grokBackgroundTasksByPaneKey.get(paneKey)
  if (!inventory?.delete(taskId)) {
    return null
  }
  if (inventory.size === 0) {
    state.grokBackgroundTasksByPaneKey.delete(paneKey)
  }
  const record = state.grokMainAgentStatusByPaneKey.get(paneKey)
  // Why: a live lead turn already owns the row; only a row the inventory holds open re-derives.
  if (record?.state !== 'done') {
    return null
  }
  const { turnCompletedAt, ...mainAgent } = record
  const resolution = foldAgentLeadStatus({
    leadState: 'done',
    childWorkLiveness: grokChildWorkLivenessAfterTurnEnd(state, paneKey, hookPayload)
  })
  const snapshot = resolveToolState(state, paneKey, {}, { resetOnNewTurn: false })
  return normalizeAgentStatusPayload({
    state: resolution.stateName,
    prompt: resolvePrompt(state, paneKey, '', { resetOnNewTurn: false }),
    agentType: 'grok',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    ...(mainAgent.outcome === 'cancellation' ? { interrupted: true } : {}),
    // Why: the turn already announced at the idle that stamped it; this restatement pairs with that.
    ...(turnCompletedAt !== undefined ? { turnCompletedAt } : {}),
    mainAgent
  })
}

/** Grok fires task_complete for every finished shell or monitor, woken or not. Only an id the
 *  inventory holds changes anything; child-owned tasks and monitors never enter it. */
export function normalizeGrokTaskCompleteNotification(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const message = readString(hookPayload, 'message')
  if (!message?.startsWith(GROK_TASK_COMPLETE_MESSAGE_PREFIX)) {
    return null
  }
  const taskId = message.slice(GROK_TASK_COMPLETE_MESSAGE_PREFIX.length).trim()
  if (!taskId || taskId.length > MAX_GROK_ID_LENGTH) {
    return null
  }
  return dropGrokFinishedTask(state, paneKey, taskId, hookPayload)
}

/** A child's lifecycle cannot settle the parent, but it does adjust the task inventory: a
 *  SubagentStart joins it, and a subagent's own end (SubagentStop, or the child's SessionEnd —
 *  the only signal a killed subagent leaves, its session id equal to the SubagentStart's
 *  subagentId) drops it. */
export function normalizeGrokSubagentLifecycleEvent(
  state: HookListenerState,
  eventName: unknown,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const subagentId =
    grokIdentityField(hookPayload, 'subagentId', 'subagent_id') ??
    grokIdentityField(hookPayload, 'sessionId', 'session_id')
  if (!subagentId) {
    return null
  }
  if (isGrokEvent(eventName, 'subagent_start')) {
    addGrokInventoryTask(state, paneKey, subagentId, 'agent')
    return null
  }
  if (!isGrokEvent(eventName, 'subagent_stop', 'subagent_end', 'session_end')) {
    return null
  }
  return dropGrokFinishedTask(state, paneKey, subagentId, hookPayload)
}
