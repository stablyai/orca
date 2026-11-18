import type { HookListenerState } from '../../../listener-state'
import type { AgentHookEventPayload } from '../../../listener-event'
import type { AgentHookSource } from '../../../transport/agent-hook-relay'
import { normalizeClaudePromptId } from '../../../listener-limits'
import { readString } from '../../../tool-input-preview'
import { readFirstString } from '../../../interactive-tool'
import { withClaudeToolRequestId } from '../../../claude-tool-request-identity'
import { isClaudePluginToolCall } from './claude-tool-events'

/** A UserPromptSubmit whose turn already began: it landed late, or was typed into the running turn. */
export const CLAUDE_LATE_PROMPT_SUBMIT_EVENT = 'UserPromptSubmit:late'

// Why 16: a late prompt trails its own turn by milliseconds; this only has to outlast a burst of short wakeup turns.
const TURN_IDS_PER_SESSION = 16
const RETIRED_SESSIONS_PER_PANE = 4

/** One pane's Claude turns, keyed by prompt_id; a new prompt_id opens a turn, so the prompt event may arrive late. */
export type ClaudePromptTurns = {
  sessionId: string | undefined
  /** Sessions this pane left; only their prompt events, which Claude does not wait for, can still arrive. */
  retiredSessionIds: string[]
  /** Admitted live turn ids, oldest first. Append-only, so no late or replayed event moves a seen turn. */
  turnIds: string[]
  /** Turns only replays after live events reported: older than the live ones, recognized but never current. */
  replayedTurnIds: string[]
  /** A live event arrived; until then only spool replays, in recorded order, fill the turn ids. */
  live: boolean
  /** The newest turn's UserPromptSubmit arrived, so whether a person or a task wakeup started it is known. */
  promptArrived: boolean
}

export type ClaudeTurnOrder = {
  eventName: unknown
  /** This live main-agent event is the first of a new Claude turn, whatever its event type. */
  opensTurn: boolean
  /** The pane's current turn, the host's native turn key. */
  turnKey?: string
}

/**
 * Claude does not wait for Orca's UserPromptSubmit hook, so its post can land after later events of its turn.
 * The turn is Claude's prompt_id instead: the first admitted main-agent event with an unseen one opens the turn, and
 * that turn's prompt event, late or typed mid-turn, is renamed so nothing treats it as a turn start. Returns null for a
 * prompt event from a session the pane already left. Call only for admitted events.
 */
function orderClaudeTurn(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  isReplay: boolean
): ClaudeTurnOrder | null {
  const passThrough = { eventName, opensTurn: false }
  // Child events share the lead's prompt_id but say nothing about the lead's turn order.
  // Plugin-made tool calls can run after Stop and do not belong to the lead's turn order either. A permission request
  // always follows its call's PreToolUse, which already placed it; one without a tool_use_id may be a plugin call's.
  if (
    source !== 'claude' ||
    readFirstString(hookPayload, ['agent_id', 'agentId']) !== undefined ||
    isClaudePluginToolCall(hookPayload) ||
    (eventName === 'PermissionRequest' &&
      readFirstString(hookPayload, ['tool_use_id', 'toolUseId']) === undefined)
  ) {
    return passThrough
  }
  const isPrompt = eventName === 'UserPromptSubmit'
  const sessionId = readString(hookPayload, 'session_id')
  const known = state.claudePromptTurnsByPaneKey.get(paneKey)
  let turns = known
  if (known && sessionId !== undefined && sessionId !== known.sessionId) {
    if (isPrompt && known.retiredSessionIds.includes(sessionId)) {
      return null
    }
    // Before live delivery, replays restate the recorded session changes in order.
    if (isReplay && known.live) {
      return passThrough
    }
    turns = {
      sessionId,
      retiredSessionIds: [
        ...known.retiredSessionIds.filter((id) => id !== sessionId),
        ...(known.sessionId !== undefined ? [known.sessionId] : [])
      ].slice(-RETIRED_SESSIONS_PER_PANE),
      turnIds: [],
      replayedTurnIds: [],
      live: false,
      promptArrived: false
    }
  } else if (!known) {
    turns = {
      sessionId,
      retiredSessionIds: [],
      turnIds: [],
      replayedTurnIds: [],
      live: false,
      promptArrived: false
    }
  }
  if (!turns) {
    return passThrough
  }
  state.claudePromptTurnsByPaneKey.set(paneKey, turns)
  if (!isReplay) {
    turns.live = true
  }
  const promptId = normalizeClaudePromptId(hookPayload.prompt_id)
  const current = turns.turnIds.at(-1)
  if (promptId === undefined) {
    return passThrough
  }
  if (turns.turnIds.includes(promptId) || turns.replayedTurnIds.includes(promptId)) {
    if (isPrompt && promptId === current) {
      turns.promptArrived = true
    }
    return {
      eventName: isPrompt ? CLAUDE_LATE_PROMPT_SUBMIT_EVENT : eventName,
      opensTurn: false,
      turnKey: current
    }
  }
  if (isReplay && turns.live) {
    // A replay after live events is older than them; it is recognized but never becomes the current turn.
    turns.replayedTurnIds = [...turns.replayedTurnIds, promptId].slice(-TURN_IDS_PER_SESSION)
    // Its prompt event is an older turn's: settle it as late so it never shows the pane working.
    return { eventName: isPrompt ? CLAUDE_LATE_PROMPT_SUBMIT_EVENT : eventName, opensTurn: false }
  }
  turns.turnIds = [...turns.turnIds, promptId].slice(-TURN_IDS_PER_SESSION)
  turns.promptArrived = isPrompt
  // Spool replay before live events restates recorded turns in order; the pane's first observed event (Orca started
  // mid-turn) cannot tell a new turn from a running one. Neither opens a turn.
  return { eventName, opensTurn: known !== undefined && !isReplay, turnKey: promptId }
}

type ClaudeHookOrder = ClaudeTurnOrder & {
  hookPayload: Record<string, unknown>
  hostTurnSignals: Pick<AgentHookEventPayload, 'nativeTurnKey' | 'opensTurn'>
}

/** Orders an admitted hook into its Claude turn and names a Claude PermissionRequest's request once, so the listener
 * and every receiver settle the same one. Null drops the event. */
export function orderClaudeHook(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  options: { isReplay?: boolean }
): ClaudeHookOrder | null {
  const order = orderClaudeTurn(
    state,
    source,
    paneKey,
    eventName,
    hookPayload,
    options.isReplay === true
  )
  if (!order) {
    return null
  }
  const hostTurnSignals = {
    ...(order.turnKey ? { nativeTurnKey: order.turnKey } : {}),
    ...(order.opensTurn ? { opensTurn: true as const } : {})
  }
  if (source !== 'claude') {
    return { ...order, hookPayload, hostTurnSignals }
  }
  return {
    ...order,
    hostTurnSignals,
    hookPayload: withClaudeToolRequestId(
      state,
      paneKey,
      order.eventName,
      hookPayload,
      order.opensTurn
    )
  }
}

/** The pane's newest Claude turn has not yet said whether a person or a task wakeup started it. */
export function isClaudeTurnStartUnclassified(state: HookListenerState, paneKey: string): boolean {
  const turns = state.claudePromptTurnsByPaneKey.get(paneKey)
  return turns !== undefined && turns.turnIds.length > 0 && !turns.promptArrived
}

/** A late prompt event belongs to the pane's newest turn, not an older one. */
export function isCurrentClaudeTurn(
  state: HookListenerState,
  paneKey: string,
  hookPayload: Record<string, unknown>
): boolean {
  const promptId = normalizeClaudePromptId(hookPayload.prompt_id)
  return (
    promptId !== undefined &&
    state.claudePromptTurnsByPaneKey.get(paneKey)?.turnIds.at(-1) === promptId
  )
}
