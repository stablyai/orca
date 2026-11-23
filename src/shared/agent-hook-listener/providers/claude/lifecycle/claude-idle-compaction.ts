import type { ParsedAgentStatusPayload } from '../../../../agent-status/contracts/agent-status-types'
import type { HookListenerState } from '../../../listener-state'
import { readString } from '../../../tool-input-preview'
import { buildClaudeCachedLeadStatusPayload } from './claude-lifecycle-events'
import { setClaudeMainAgentTurnState, updateClaudeRunningNonAgentTask } from './claude-roster-state'
import { isClaudeToolEvent } from './claude-tool-events'
import { readClaudeBackgroundAgentTasks } from '../background-tasks/claude-background-task-inventory'

/**
 * Claude Code can compact a finished conversation while it sits idle (CLI `idleCompaction`, on by default). That
 * compaction runs after the turn's `Stop` and never emits another one: it restores context files through the
 * ordinary `PreToolUse`/`PostToolUse` hooks, which would otherwise reopen the pane as working for good (#47703).
 *
 * The compaction's own first hook is `PreCompact`, so the lead state at that moment tells the two cases apart. A
 * turn still running (or waiting on a person) is mid-turn compaction, whose restored reads belong to that turn and
 * still end with its `Stop`. Only a lead that had already reported `done` is compacting while idle.
 *
 * The hold names the compacted turn's `prompt_id`, so another turn's activity — or a real `Stop` — always wins.
 */
export function settleClaudeIdleCompaction(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  opensTurn: boolean
): ParsedAgentStatusPayload | null {
  const lead = state.claudeLeadStateByPaneKey.get(paneKey)
  if (eventName === 'PreCompact') {
    if (lead?.state !== 'done' || hookPayload['trigger'] !== 'auto') {
      return null
    }
    setClaudeMainAgentTurnState(state, paneKey, {
      ...lead,
      idleCompactionTurnId: readTurnId(hookPayload)
    })
  }
  const heldTurnId = state.claudeLeadStateByPaneKey.get(paneKey)?.idleCompactionTurnId
  if (
    heldTurnId === undefined ||
    opensTurn ||
    // A child's own tool hooks must keep building its roster row; only the lead's activity is the compaction's.
    readString(hookPayload, 'agent_id') !== undefined ||
    eventName === 'Stop' ||
    eventName === 'StopFailure' ||
    (readTurnId(hookPayload) || heldTurnId) !== heldTurnId ||
    !(eventName === 'PreCompact' || eventName === 'PostCompact' || isClaudeToolEvent(eventName))
  ) {
    return null
  }
  // The compaction's own hooks still carry the run's shell inventory; restating the cached lead would keep it stale.
  const backgroundTasks = readClaudeBackgroundAgentTasks(hookPayload)
  if (backgroundTasks.present) {
    updateClaudeRunningNonAgentTask(state, paneKey, backgroundTasks)
  }
  // Restate the finished turn, so the row a receiver holds never reopens on the compaction's own activity.
  return buildClaudeCachedLeadStatusPayload(state, eventName, paneKey, hookPayload)
}

/** The raw turn id a hook carries; compared, not parsed, so an unfamiliar id still distinguishes turns. */
function readTurnId(hookPayload: Record<string, unknown>): string {
  const promptId = hookPayload['prompt_id']
  return typeof promptId === 'string' ? promptId.trim().toLowerCase() : ''
}
