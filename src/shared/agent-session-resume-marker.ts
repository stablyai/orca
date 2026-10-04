// What a teardown recorded about a session that was genuinely working when the app went away.
//
// A marker is written ONLY by the teardown path, from the live runtime — never derived from a
// persisted `running` row, which survives a crash and would resurrect work nobody is doing. The
// marker is both the offer and its description: what the session was doing is captured on it at
// the stop, because that fact exists only in memory at that moment — the provider rewrites the
// journal in its own words on reattach.
//
// A marker has no expiry. It ends when the chat's agent is started again other than by its own
// continuation, or by a successful resume, a dismissal, or closing the chat — each of which
// deletes it.

import { z } from 'zod'
import { AGENT_STATUS_STATES } from './agent-status-types'
import { AGENT_CHILD_WORK_KINDS } from './agent-status-child-work'
import {
  AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS,
  AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS
} from './agent-session-restart-activity'
import type { AgentSessionRestartActivity } from './agent-session-restart-activity'
import type { AgentJournalCursor } from './agent-session-journal-types'

/** Why the app went away. Recorded because an update install is a restart the user did not choose,
 *  and the surface that offers the resume says so. */
export const AGENT_SESSION_RESUME_TRIGGERS = ['quit', 'update'] as const
export type AgentSessionResumeTrigger = (typeof AGENT_SESSION_RESUME_TRIGGERS)[number]

/** How an acted-on offer ended without the agent carrying on. `refused` is a definite no from the
 *  host or provider; `unconfirmed` means the continuation may have gone out and nothing proved it. */
export const AGENT_SESSION_RESUME_FAILURE_OUTCOMES = ['refused', 'unconfirmed'] as const
export type AgentSessionResumeFailureOutcome =
  (typeof AGENT_SESSION_RESUME_FAILURE_OUTCOMES)[number]

/**
 * WHAT the session was working on, in whichever identity that work actually had.
 *
 * A turn id is not always available. Codex declares its turn within ~150ms, but Claude cannot write
 * a running turn until the SDK echoes the user message back — seconds on real journals. A send is
 * journaled before provider dispatch, so the projection already calls that window `working`. Forcing
 * a turn-id shape onto it would drop exactly those genuinely-working Claude sessions, so a
 * submission carries its own identity instead of being made to look like a turn.
 */
export type AgentSessionResumeWork =
  | { kind: 'turn'; id: string }
  | { kind: 'submission'; id: string }

export type AgentSessionResumeMarker = {
  sessionId: string
  /** The work in flight when teardown observed it — a running turn, or a send that had not yet
   *  become one. */
  work: AgentSessionResumeWork
  /** The user message observed at teardown. Nothing reads it; still written for one release so the
   *  previous build, whose parser requires it, can read this marker after a downgrade. */
  latestUserItemId?: string | null
  /** Execution host's clock at teardown. */
  recordedAt: number
  trigger: AgentSessionResumeTrigger
  /**
   * IDENTITY ROOT of the provider handle this session had proved at teardown — deliberately not the
   * full handle key.
   *
   * The key embeds Claude's leaf uuid, which is a branch cursor, and the adapter's own close path
   * appends a `resumed` link with an advanced leaf seconds after the marker is written. Comparing
   * keys therefore refuses every Claude session forever. The root is the part a resume must
   * preserve — a resume that changes it forked — which is exactly what this guard is for.
   */
  providerHandleRoot: string
  /** Stable teardown identity for continuation deduplication, not launch ancestry. */
  teardownId: string
  /**
   * Where the chat's journal stood when the offer was taken. A message accepted after it, or a
   * journal on another epoch, means the chat moved on. Absent on markers from builds that did not
   * record it.
   */
  journalCursor?: AgentJournalCursor
  /**
   * What the session was doing, captured at the same stop-time snapshot that decided the offer.
   * The dialog row, the status bar and the wire candidate read ONLY this; nothing re-reads the
   * journal after the restart for the description.
   *
   * Absent on markers from builds that recorded no snapshot. Optional so an older build strips it
   * and still reads the marker; `work` keeps its two kinds for the same reason, because a kind
   * that build cannot parse makes it reject the whole capsule.
   */
  activity?: AgentSessionRestartActivity
}

const MAX_FIELD_LENGTH = 512

/** Bounded because a marker is read back from a file this process did not necessarily write. */
const markerField = z.string().min(1).max(MAX_FIELD_LENGTH)

const agentSessionResumeWorkSchema = z.object({
  kind: z.enum(['turn', 'submission']),
  id: markerField
})

const activityLabel = z.string().max(AGENT_SESSION_RESTART_ACTIVITY_MAX_LABEL_LENGTH)

const agentSessionRestartActivitySchema = z.object({
  state: z.enum(AGENT_STATUS_STATES),
  prompts: z
    .array(z.object({ kind: z.enum(['approval', 'question']), label: activityLabel }))
    .max(AGENT_SESSION_RESTART_ACTIVITY_MAX_PROMPTS),
  tasks: z
    .array(z.object({ kind: z.enum(AGENT_CHILD_WORK_KINDS), label: activityLabel }))
    .max(AGENT_SESSION_RESTART_ACTIVITY_MAX_TASKS)
})

/**
 * The single parse boundary for a marker.
 *
 * Markers re-enter from the capsule as JSON this process may not have written — an older build, a
 * hand-edited profile, a partially recovered file. Everything downstream dereferences the shape
 * without guards and decides whether to hand an agent a provider child, so the untyped value is
 * turned into a typed one exactly once, here, and never read field-by-field off `unknown`.
 *
 * Unknown keys pass: a marker written by a slightly newer build must not read as malformed.
 * The activity is display only, so one this build cannot read is dropped rather than costing
 * the whole offer.
 */
const agentSessionResumeMarkerSchema = z.object({
  sessionId: markerField,
  work: agentSessionResumeWorkSchema,
  latestUserItemId: markerField.nullable().optional(),
  recordedAt: z.number().int().nonnegative(),
  trigger: z.enum(AGENT_SESSION_RESUME_TRIGGERS),
  providerHandleRoot: markerField,
  teardownId: markerField,
  journalCursor: z
    .object({ epoch: markerField, sequence: z.number().int().nonnegative() })
    .optional()
    .catch(undefined),
  activity: agentSessionRestartActivitySchema.optional().catch(undefined)
})

/** The marker this value describes, or null when it is not one. Null is always a drop, never a
 *  throw: a malformed advisory marker must never make a user's sessions unreadable. */
export function parseAgentSessionResumeMarker(value: unknown): AgentSessionResumeMarker | null {
  const parsed = agentSessionResumeMarkerSchema.safeParse(value)
  if (!parsed.success) {
    return null
  }
  const { activity, journalCursor, ...marker } = parsed.data
  return {
    ...marker,
    ...(journalCursor === undefined ? {} : { journalCursor }),
    ...(activity === undefined ? {} : { activity })
  }
}
