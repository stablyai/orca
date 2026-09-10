import type { AgentHookSource } from '../agent-hook-relay'
import {
  agentDescendantEffectiveState,
  agentDescendantRosterToSnapshots,
  finishAgentDescendant,
  pruneStaleAgentDescendants,
  replaceAgentDescendants,
  upsertAgentDescendant,
  type AgentDescendantRoster
} from '../agent-descendant-roster'
import { normalizeAgentStatusPayload, type ParsedAgentStatusPayload } from '../agent-status-types'
import type { DescendantEventFacts } from './descendant-events'
import type { HookListenerState } from './listener-state'

function getOrCreateDescendantRoster(
  state: HookListenerState,
  paneKey: string
): AgentDescendantRoster {
  let roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    roster = new Map()
    state.descendantRosterByPaneKey.set(paneKey, roster)
  }
  return roster
}

/** Apply a descendant's lifecycle event: it updates the child list and republishes
 *  the pane from the LEAD's last known state, so a child finishing can never be the
 *  pane's completion. The lead's own tool/prompt caches are left untouched — a
 *  child's tool call is not the pane's, and overwriting them would relabel the row
 *  with the child's work. */
export function applyDescendantEventToPane(
  state: HookListenerState,
  source: AgentHookSource,
  paneKey: string,
  facts: DescendantEventFacts
): ParsedAgentStatusPayload | null {
  const now = Date.now()
  if (facts.kind === 'live-set') {
    const roster = getOrCreateDescendantRoster(state, paneKey)
    replaceAgentDescendants(roster, facts.children, now)
  } else if (facts.id) {
    if (facts.ended) {
      finishAgentDescendant(state.descendantRosterByPaneKey.get(paneKey) ?? new Map(), facts.id)
    } else {
      upsertAgentDescendant(
        getOrCreateDescendantRoster(state, paneKey),
        facts.id,
        {
          agentType: facts.agentType,
          description: facts.description,
          model: facts.model,
          state: facts.waiting === true ? 'waiting' : 'working'
        },
        now
      )
    }
  }
  dropEmptyDescendantRoster(state, paneKey, now)

  // Why: a child event before any lead event still proves the pane is working — the lead spawned it.
  const leadState = state.descendantLeadStateByPaneKey.get(paneKey) ?? 'working'
  const cachedTool = state.lastToolByPaneKey.get(paneKey) ?? {}
  // Why: a child's wait must surface even when its provider never named which child is waiting,
  // so there is no roster row to carry the state.
  const effectiveState =
    facts.kind === 'child' && facts.waiting === true
      ? 'waiting'
      : agentDescendantEffectiveState(state.descendantRosterByPaneKey.get(paneKey), leadState)
  return normalizeAgentStatusPayload({
    state: effectiveState,
    prompt: state.lastPromptByPaneKey.get(paneKey) ?? '',
    agentType: source,
    toolName: cachedTool.toolName,
    toolInput: cachedTool.toolInput,
    interactivePrompt: cachedTool.interactivePrompt,
    lastAssistantMessage: cachedTool.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: cachedTool.lastAssistantMessageIsToolOutput,
    subagents: agentDescendantRosterToSnapshots(state.descendantRosterByPaneKey.get(paneKey))
  })
}

/** The pane is idle only when its lead session is idle AND no descendant is live.
 *  Records the lead's own verdict first, so draining the last descendant later
 *  republishes what the lead actually said instead of the gated value. */
export function gatePaneStateOnDescendants(
  state: HookListenerState,
  paneKey: string,
  payload: ParsedAgentStatusPayload | null
): ParsedAgentStatusPayload | null {
  if (!payload) {
    return payload
  }
  state.descendantLeadStateByPaneKey.set(paneKey, payload.state)
  dropEmptyDescendantRoster(state, paneKey, Date.now())
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    return payload
  }
  return {
    ...payload,
    state: agentDescendantEffectiveState(roster, payload.state),
    subagents: agentDescendantRosterToSnapshots(roster)
  }
}

/** Reap children nothing has mentioned for the quiet window, then forget a roster with
 *  nothing left in it — the pane must not keep a claim it can no longer justify. */
function dropEmptyDescendantRoster(state: HookListenerState, paneKey: string, now: number): void {
  const roster = state.descendantRosterByPaneKey.get(paneKey)
  if (!roster) {
    return
  }
  pruneStaleAgentDescendants(roster, now)
  if (roster.size === 0) {
    state.descendantRosterByPaneKey.delete(paneKey)
  }
}

export function clearDescendantScope(state: HookListenerState, paneKey: string): void {
  state.descendantRosterByPaneKey.delete(paneKey)
  state.descendantLeadStateByPaneKey.delete(paneKey)
}
