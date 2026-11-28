import type { ParsedAgentStatusPayload } from '../../../agent-status/contracts/agent-status-types'
import type { AgentMainAgentStatus } from '../../../agent-status/lifecycle/main-agent-status'
import type { CodexSubagentRoster } from '../codex/codex-subagent-roster'
import type { AgentHookEventPayload } from '../../listener-event'
import { clearPaneTurnCacheState, type HookListenerState } from '../../listener-state'
import { providerPaneStateSlot } from '../../state/provider-hook-state-slots'
import { readString } from '../../tool-input-preview'
import { readDroidTranscriptCallingSessionId } from './droid-transcript-origin'

const MAX_TRACKED_SESSIONS = 256

const droidSessionsByPaneKey = providerPaneStateSlot<DroidPaneSessions>(true)

/** The pane's Droid sessions; undefined before its first Droid hook or after teardown. */
export function droidPaneSessions(
  state: HookListenerState,
  paneKey: string
): DroidPaneSessions | undefined {
  return droidSessionsByPaneKey(state.providerState).get(paneKey)
}

type DroidChild = {
  parentId: string
  /** Seen after a lead Stop, or started while the lead was stopped; an idle prompt does not end it. */
  outlivedStop: boolean
}

/** One Droid pane: the lead session that owns the row, and every other session as a flat child. */
export type DroidPaneSessions = {
  leadId: string
  /** The first session seen with no start behind it; a `calling_session_id` can still repoint it. */
  provisional: boolean
  lead?: AgentMainAgentStatus
  children: Map<string, DroidChild>
  /** Children that ended; a late second start for one (0.244) must not bring it back. */
  finished: Set<string>
  /** The children on show: working or waiting. */
  roster: CodexSubagentRoster
  leaseUntil?: number
}

export type DroidHookAdmission =
  | { kind: 'skip' }
  /** Re-publish the stored row so the host's owner check runs; `settled` also clears child work. */
  | { kind: 'restate'; settled?: true }
  | { kind: 'lead'; sessions?: DroidPaneSessions }
  | { kind: 'child'; sessions: DroidPaneSessions; sessionId: string }

const SKIP: DroidHookAdmission = { kind: 'skip' }

function boundedAdd<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next()
    if (!oldest.done) {
      map.delete(oldest.value)
    }
  }
}

function createSessions(
  state: HookListenerState,
  paneKey: string,
  leadId: string,
  provisional: boolean
): DroidPaneSessions {
  const sessions: DroidPaneSessions = {
    leadId,
    provisional,
    children: new Map(),
    finished: new Set(),
    roster: new Map()
  }
  droidSessionsByPaneKey(state.providerState).set(paneKey, sessions)
  return sessions
}

function chainRoot(sessions: DroidPaneSessions, id: string): string {
  const seen = new Set<string>()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const parent = sessions.children.get(current)?.parentId
    if (!parent) {
      return current
    }
    current = parent
  }
  return current
}

function recordChild(sessions: DroidPaneSessions, id: string, parentId: string): void {
  if (!sessions.children.has(id)) {
    boundedAdd(sessions.children, id, {
      parentId,
      outlivedStop: sessions.lead?.state === 'done'
    })
  }
}

// Why: a child proves the lead has a child, not that it has no parent, so it stays repointable.
function repointProvisionalLead(sessions: DroidPaneSessions, parentId: string): void {
  const root = chainRoot(sessions, parentId)
  if (root !== sessions.leadId) {
    recordChild(sessions, sessions.leadId, root)
    sessions.leadId = root
    sessions.lead = undefined
  }
}

function restoredSessions(
  state: HookListenerState,
  paneKey: string,
  previous: AgentHookEventPayload | undefined
): DroidPaneSessions | undefined {
  const id = previous?.providerSession?.id
  return id && previous.payload.agentType === 'droid' && !previous.agentPresence?.ended
    ? createSessions(state, paneKey, id, false)
    : undefined
}

/** Records a session its parent names; the pane's sessions when it is now a live child. */
function adoptChild(
  state: HookListenerState,
  paneKey: string,
  sessions: DroidPaneSessions | undefined,
  sessionId: string,
  parentId: string
): DroidPaneSessions | undefined {
  const known = sessions ?? createSessions(state, paneKey, parentId, true)
  if (known.finished.has(sessionId)) {
    return undefined
  }
  if (known.provisional) {
    repointProvisionalLead(known, parentId)
  }
  // Why: a confirmed lead is never a child, but a provisional one can turn out to be.
  if (sessionId !== known.leadId) {
    recordChild(known, sessionId, parentId)
  }
  return known.children.has(sessionId) ? known : undefined
}

function admitStart(
  state: HookListenerState,
  paneKey: string,
  sessions: DroidPaneSessions | undefined,
  previous: AgentHookEventPayload | undefined,
  ids: { sessionId: string; parentId?: string }
): DroidHookAdmission {
  const { sessionId, parentId } = ids
  if (parentId) {
    adoptChild(state, paneKey, sessions, sessionId, parentId)
    return SKIP
  }
  const hadChildWork = (sessions?.roster.size ?? 0) > 0
  createSessions(state, paneKey, sessionId, false)
  clearPaneTurnCacheState(state, paneKey)
  return hadChildWork && previous ? { kind: 'restate', settled: true } : SKIP
}

/**
 * Sorts one Droid hook into the lead's, a child's, or neither, and records what a start teaches.
 * Events with no session id keep the pre-split behavior: they are the lead's.
 */
export function admitDroidHook(
  state: HookListenerState,
  paneKey: string,
  eventName: unknown,
  hookPayload: Record<string, unknown>,
  previous: AgentHookEventPayload | undefined
): DroidHookAdmission {
  if (eventName === 'SessionEnd') {
    return SKIP
  }
  const sessionId = readString(hookPayload, 'session_id')
  if (!sessionId) {
    return { kind: 'lead' }
  }
  const sessions = droidPaneSessions(state, paneKey) ?? restoredSessions(state, paneKey, previous)
  const isStart = eventName === 'SessionStart'
  const unseen = sessionId !== sessions?.leadId && !sessions?.children.has(sessionId)
  const parentId =
    (isStart ? readString(hookPayload, 'calling_session_id') : undefined) ??
    (isStart || unseen ? readDroidTranscriptCallingSessionId(hookPayload) : undefined)
  if (isStart) {
    return admitStart(state, paneKey, sessions, previous, { sessionId, parentId })
  }
  if (parentId) {
    const known = adoptChild(state, paneKey, sessions, sessionId, parentId)
    return known ? { kind: 'child', sessions: known, sessionId } : SKIP
  }
  if (!sessions) {
    return {
      kind: 'lead',
      sessions: createSessions(state, paneKey, sessionId, true)
    }
  }
  if (sessionId === sessions.leadId) {
    return { kind: 'lead', sessions }
  }
  // Why: a prompt from an unseen session that names no caller is the user's, so it takes the pane.
  if (eventName === 'UserPromptSubmit' && unseen && !sessions.finished.has(sessionId)) {
    clearPaneTurnCacheState(state, paneKey)
    return { kind: 'lead', sessions: createSessions(state, paneKey, sessionId, false) }
  }
  return sessions.children.has(sessionId) ? { kind: 'child', sessions, sessionId } : SKIP
}

/** The stored row re-published under the sender so the owner check and exit watch see it; null for a skip. */
export function restatedDroidEvent(
  previous: AgentHookEventPayload | undefined,
  admission: Extract<DroidHookAdmission, { kind: 'skip' | 'restate' }>,
  base: Pick<
    AgentHookEventPayload,
    'launchToken' | 'tabId' | 'worktreeId' | 'agentPresence' | 'providerSession'
  >
): AgentHookEventPayload | null {
  if (!previous || admission.kind === 'skip') {
    return null
  }
  const payload: ParsedAgentStatusPayload = admission.settled
    ? {
        ...previous.payload,
        state: 'done',
        workingMode: undefined,
        subagents: undefined,
        mainAgent: undefined
      }
    : previous.payload
  return {
    ...base,
    paneKey: previous.paneKey,
    source: 'droid',
    connectionId: null,
    // Why: the restated row is kept for resume, so it names the lead the pane holds, not the sender's.
    providerSession: admission.settled ? base.providerSession : previous.providerSession,
    payload
  }
}

/** A child event restates the pane's resume identity and never supplies one of its own. */
export function droidRowProviderSession(
  admission: DroidHookAdmission | undefined,
  own: AgentHookEventPayload['providerSession'] | null,
  previous: AgentHookEventPayload | undefined
): AgentHookEventPayload['providerSession'] | null {
  if (admission?.kind !== 'child') {
    return own
  }
  return (previous?.payload.agentType === 'droid' ? previous.providerSession : undefined) ?? null
}
