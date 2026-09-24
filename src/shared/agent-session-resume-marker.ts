// What a teardown recorded about a session that was genuinely working when the app went away.
//
// A marker is written ONLY by the teardown path, from the live runtime — never derived from a
// persisted `running` row, which survives a crash and would resurrect work nobody is doing. It is
// the first of two records a resume needs: the journal's own turn record has to name the same turn
// before anything is handed a provider child again.
//
// The capsule is consumed before offers enter runtime memory; unused witnesses also expire.

import { z } from 'zod'

/** Why the app went away. Recorded because an update install is a restart the user did not choose,
 *  and the surface that offers the resume says so. */
export const AGENT_SESSION_RESUME_TRIGGERS = ['quit', 'update'] as const
export type AgentSessionResumeTrigger = (typeof AGENT_SESSION_RESUME_TRIGGERS)[number]

/** A marker older than this is ignored and pruned: relaunching a week later must not restart a turn
 *  the user has long since forgotten, and an obligation with no expiry strands forever. */
export const AGENT_SESSION_RESUME_MARKER_TTL_MS = 24 * 60 * 60 * 1000

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
  /** The user message observed at teardown; a newer one supersedes this offer before its turn opens. */
  latestUserItemId: string | null
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
}

const MAX_FIELD_LENGTH = 512

/** Bounded because a marker is read back from a file this process did not necessarily write. */
const markerField = z.string().min(1).max(MAX_FIELD_LENGTH)

const agentSessionResumeWorkSchema = z.object({
  kind: z.enum(['turn', 'submission']),
  id: markerField
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
 */
const agentSessionResumeMarkerSchema = z.object({
  sessionId: markerField,
  work: agentSessionResumeWorkSchema,
  latestUserItemId: markerField.nullable(),
  recordedAt: z.number().int().nonnegative(),
  trigger: z.enum(AGENT_SESSION_RESUME_TRIGGERS),
  providerHandleRoot: markerField,
  teardownId: markerField
})

/** The marker this value describes, or null when it is not one. Null is always a drop, never a
 *  throw: a malformed advisory marker must never make a user's sessions unreadable. */
export function parseAgentSessionResumeMarker(value: unknown): AgentSessionResumeMarker | null {
  const parsed = agentSessionResumeMarkerSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function isExpiredAgentSessionResumeMarker(
  marker: AgentSessionResumeMarker,
  now: number
): boolean {
  // A marker from the future is a clock that moved backwards, not a fresh one; treat it as expired
  // rather than let it outlive every TTL.
  return now < marker.recordedAt || now - marker.recordedAt > AGENT_SESSION_RESUME_MARKER_TTL_MS
}
