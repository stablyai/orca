import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import type { HookListenerState } from '../../../listener-state'
import type { AgentHookSource } from '../../../transport/agent-hook-relay'
import { normalizeClaudePromptId } from '../../../listener-limits'
import { resolvePrompt } from '../../../prompt-fields'
import { readString } from '../../../tool-input-preview'
import { readClaudeBackgroundAgentTasks } from '../background-tasks/claude-background-task-inventory'
import { trackClaudeTaskNotificationDelivery } from '../background-tasks/claude-task-notification-delivery'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'

/** A UserPromptSubmit whose turn already began: it landed late, or was typed into the running turn. */
export const CLAUDE_LATE_PROMPT_SUBMIT_EVENT = 'UserPromptSubmit:late'

// Why 4: a prompt event can trail its own turn, and in theory the next one; older turns are long settled.
const SEEN_PROMPT_IDS_PER_PANE = 4

/**
 * Claude does not wait for Orca's UserPromptSubmit hook, so its post can land after a later event of
 * the same turn (a fast Stop). Every main-agent event records its prompt_id, newest last; a UserPromptSubmit
 * whose prompt was already seen is renamed before any normalization, so nothing treats it as a turn start.
 * A prompt typed mid-turn shares the running turn's prompt_id, so it lands here too and only relabels the turn.
 */
export function orderClaudeHook(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): unknown {
  const promptId = source === 'claude' ? normalizeClaudePromptId(hookPayload.prompt_id) : undefined
  // Child events share the lead's prompt_id but say nothing about the lead's turn order.
  if (promptId === undefined || readString(hookPayload, 'agent_id') !== undefined) {
    return eventName
  }
  const seen = state.claudeAdvancedPromptIdsByPaneKey.get(paneKey)
  if (eventName === 'UserPromptSubmit' && seen?.includes(promptId)) {
    return CLAUDE_LATE_PROMPT_SUBMIT_EVENT
  }
  if (seen?.at(-1) !== promptId) {
    const next = (seen ?? []).filter((id) => id !== promptId)
    next.push(promptId)
    state.claudeAdvancedPromptIdsByPaneKey.set(paneKey, next.slice(-SEEN_PROMPT_IDS_PER_PANE))
  }
  return eventName
}

/** Settles the late prompt's task notification and, for the pane's current turn, its label and wakeup flag. */
export function settleLateClaudePromptSubmit(
  state: HookListenerState,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const isTaskWakeup = trackClaudeTaskNotificationDelivery(
    state,
    paneKey,
    'UserPromptSubmit',
    hookPayload,
    readClaudeBackgroundAgentTasks(hookPayload)
  )
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  const currentTurn =
    state.claudeAdvancedPromptIdsByPaneKey.get(paneKey)?.at(-1) ===
    normalizeClaudePromptId(hookPayload.prompt_id)
  // A cleared pane or an older turn's prompt must not relabel what the pane shows now.
  if (!lead || !currentTurn) {
    return null
  }
  const own = lead.waitingAgentId !== undefined ? lead.stateBeforeWait : lead
  if (isTaskWakeup && own && own.state !== 'done') {
    own.taskWakeupTurn = true
  }
  resolvePrompt(state, paneKey, promptText)
  return buildClaudeCachedLeadStatusPayload(
    state,
    CLAUDE_LATE_PROMPT_SUBMIT_EVENT,
    paneKey,
    hookPayload
  )
}
