import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import type { HookListenerState } from '../../../listener-state'
import { resolvePrompt } from '../../../prompt-fields'
import { readClaudeBackgroundAgentTasks } from '../background-tasks/claude-background-task-inventory'
import { trackClaudeTaskNotificationDelivery } from '../background-tasks/claude-task-notification-delivery'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import { claudePaneHasRunningChildWork } from './claude-pane-hold-evidence'
import { CLAUDE_LATE_PROMPT_SUBMIT_EVENT, isCurrentClaudeTurn } from './claude-prompt-turn-order'

/** Settles the late prompt's task notification and, for the pane's current turn, its label, wakeup flag and held completion. */
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
  // A cleared pane or an older turn's prompt must not relabel what the pane shows now.
  if (!lead || !isCurrentClaudeTurn(state, paneKey, hookPayload)) {
    return null
  }
  const own = lead.waitingAgentId !== undefined ? lead.stateBeforeWait : lead
  if (isTaskWakeup && own && own.state !== 'done') {
    own.taskWakeupTurn = true
  }
  const heldEnd = lead.unclassifiedTurnCompletedAt
  lead.unclassifiedTurnCompletedAt = undefined
  // A person's turn that Stop already ended earns the completion it held; a wakeup's never does.
  if (
    heldEnd !== undefined &&
    !isTaskWakeup &&
    lead.state === 'done' &&
    claudePaneHasRunningChildWork(state, paneKey)
  ) {
    lead.turnCompletedAt = heldEnd
  }
  resolvePrompt(state, paneKey, promptText)
  return buildClaudeCachedLeadStatusPayload(
    state,
    CLAUDE_LATE_PROMPT_SUBMIT_EVENT,
    paneKey,
    hookPayload
  )
}
