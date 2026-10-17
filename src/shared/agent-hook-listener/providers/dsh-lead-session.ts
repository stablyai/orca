import type { DshPaneState, HookListenerState } from '../listener-state'
import { readString } from '../tool-input-preview'

const MAX_TRACKED_SESSIONS = 64

/**
 * How long an unclaimed session must have been heard from before it may lead the pane. A child's
 * SessionStart, first prompt and SubagentStart hooks all launch within one tick of each other, so
 * a claim lands well inside this; a /new or /resume session's prompt waits on a human.
 */
export const DSH_UNCLAIMED_SESSION_GRACE_MS = 1500

export type DshLeadDecision =
  | { kind: 'drop' }
  | { kind: 'lead' }
  /** The session just became the lead; `heldPrompt` is its prompt that arrived while it was held. */
  | { kind: 'adopted'; heldPrompt?: string }

function getDshPaneState(state: HookListenerState, paneKey: string): DshPaneState {
  let pane = state.dshPaneStateByPaneKey.get(paneKey)
  if (!pane) {
    pane = { leadTurnOpen: false, childSessionIds: new Set(), candidates: new Map() }
    // Why: after a restart the hydrated row still names the lead; seeding it keeps a child's
    // SessionStart, which beats its SubagentStart, from being adopted as the first speaker.
    const restored = state.lastStatusByPaneKey.get(paneKey)
    if (restored?.payload.agentType === 'dsh' && restored.providerSession?.key === 'session_id') {
      pane.leadSessionId = restored.providerSession.id
      pane.leadTurnOpen = restored.payload.state !== 'done'
    }
    state.dshPaneStateByPaneKey.set(paneKey, pane)
  }
  return pane
}

function evictOldest(entries: Set<string> | Map<string, unknown>): void {
  if (entries.size <= MAX_TRACKED_SESSIONS) {
    return
  }
  const oldest = entries.keys().next().value
  if (oldest !== undefined) {
    entries.delete(oldest)
  }
}

function markChild(pane: DshPaneState, sessionId: string): void {
  pane.candidates.delete(sessionId)
  pane.childSessionIds.delete(sessionId)
  pane.childSessionIds.add(sessionId)
  evictOldest(pane.childSessionIds)
}

function adoptLead(pane: DshPaneState, sessionId: string): void {
  pane.previousLead =
    pane.leadSessionId === undefined
      ? undefined
      : { sessionId: pane.leadSessionId, turnOpen: pane.leadTurnOpen }
  pane.leadSessionId = sessionId
  pane.leadTurnOpen = false
  pane.candidates.delete(sessionId)
}

/** The lead turned out to be a child: hand the pane back to whoever led before it. */
function demoteLead(pane: DshPaneState): void {
  if (pane.leadSessionId !== undefined) {
    markChild(pane, pane.leadSessionId)
  }
  pane.leadSessionId = pane.previousLead?.sessionId
  pane.leadTurnOpen = pane.previousLead?.turnOpen ?? false
  pane.previousLead = undefined
}

function claimChild(pane: DshPaneState, childId: string): void {
  if (pane.leadSessionId === childId) {
    demoteLead(pane)
  }
  markChild(pane, childId)
}

function decideUnknownSession(
  pane: DshPaneState,
  sessionId: string,
  eventName: unknown,
  promptText: string
): DshLeadDecision {
  // Why: children are only created inside a lead turn, so a session starting at an idle composer
  // is /new, /resume or /fork and becomes the resume target before its first prompt.
  if (eventName === 'SessionStart' && !pane.leadTurnOpen) {
    adoptLead(pane, sessionId)
    return { kind: 'adopted' }
  }
  const now = Date.now()
  const candidate = pane.candidates.get(sessionId)
  if (!candidate || eventName === 'SessionStart') {
    pane.candidates.delete(sessionId)
    pane.candidates.set(sessionId, {
      heldSince: now,
      ...(eventName === 'UserPromptSubmit' && promptText ? { heldPrompt: promptText } : {})
    })
    evictOldest(pane.candidates)
    return { kind: 'drop' }
  }
  if (now - candidate.heldSince < DSH_UNCLAIMED_SESSION_GRACE_MS) {
    if (eventName === 'UserPromptSubmit' && promptText) {
      candidate.heldPrompt = promptText
    }
    return { kind: 'drop' }
  }
  // Why: no Subagent edge claimed it in time, so this is a lead whose old turn never posted Stop
  // (an interrupt) before the user switched sessions.
  const heldPrompt = candidate.heldPrompt
  adoptLead(pane, sessionId)
  return { kind: 'adopted', ...(heldPrompt ? { heldPrompt } : {}) }
}

function decide(
  pane: DshPaneState,
  sessionId: string,
  eventName: unknown,
  promptText: string
): DshLeadDecision {
  if (pane.childSessionIds.has(sessionId)) {
    return { kind: 'drop' }
  }
  if (sessionId === pane.leadSessionId) {
    return { kind: 'lead' }
  }
  // Why: a fresh listener (Orca or relay restart) knows no lead; the first speaker is the best
  // guess, and a Subagent edge naming it hands the pane on.
  if (pane.leadSessionId === undefined) {
    adoptLead(pane, sessionId)
    return { kind: 'adopted' }
  }
  // Why: a replaced lead still mid-turn and still talking means its replacement was a child no
  // edge claimed (a DSH process started before Orca registered the Subagent hooks).
  if (
    sessionId === pane.previousLead?.sessionId &&
    pane.previousLead.turnOpen &&
    eventName !== 'SessionStart'
  ) {
    demoteLead(pane)
    return { kind: 'lead' }
  }
  return decideUnknownSession(pane, sessionId, eventName, promptText)
}

function trackLeadTurn(pane: DshPaneState, eventName: unknown): void {
  if (eventName === 'SessionStart' || eventName === 'Stop') {
    pane.leadTurnOpen = false
  } else if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
  ) {
    pane.leadTurnOpen = true
  }
}

/**
 * Decides whether a DSH hook speaks for the pane's lead agent.
 *
 * Why: the bridge fires every lifecycle hook for every in-process agent, stamped with that
 * agent's own session id, so a child's prompt, tools and Stop would otherwise drive the pane and
 * its id would become the resume target. Only SubagentStart/SubagentStop name children, and a
 * child's SessionStart (always) and first prompt (sometimes) land before them, so an unknown id
 * met mid-turn is held until an edge claims it or it outlives the grace.
 */
export function resolveDshLeadEvent(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  promptText: string,
  hookPayload: Record<string, unknown>
): DshLeadDecision {
  const pane = getDshPaneState(state, paneKey)
  if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    // Why both: `session_id` is '' for a non-local provider's child; `agent_id` is always set.
    for (const childId of new Set([
      readString(hookPayload, 'agent_id'),
      readString(hookPayload, 'session_id')
    ])) {
      if (childId) {
        claimChild(pane, childId)
      }
    }
    return { kind: 'drop' }
  }

  const sessionId = readString(hookPayload, 'session_id')
  // Why: the bridge sends '' only when it has no agent to name, so there is no child to blame.
  if (!sessionId) {
    return { kind: 'lead' }
  }
  const decision = decide(pane, sessionId, eventName, promptText)
  if (decision.kind !== 'drop') {
    trackLeadTurn(pane, eventName)
  }
  return decision
}
