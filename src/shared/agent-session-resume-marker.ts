// Teardown captures live work/activity once; persisted running rows could resurrect nonexistent work and reattach rewrites history.
// No expiry: remove on a non-continuation start, successful resume, dismissal or chat close.

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

/** Use the actual work identity: Claude may take seconds to echo a turn while its journaled submission is already working. Requiring a turn ID would omit genuinely active sends. */
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
  /** Compare provider identity roots: Claude close advances the leaf after teardown, so full-key checks would refuse every resume. A changed root is a fork. */
  providerHandleRoot: string
  /** Stable teardown identity for continuation deduplication, not launch ancestry. */
  teardownId: string
  /** Offer-time journal position; later accepted messages or another epoch mean the chat moved on. Older markers omit it. */
  journalCursor?: AgentJournalCursor
  contextClearOperationId?: string
  /** Use only the stop-time activity capture for dialog/status/wire descriptions, never restarted history. Optional activity preserves older capsule parsing; work retains its two known kinds for the same reason. */
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

/** Parse foreign/recovered capsule JSON once before unguarded consumers can launch children. Preserve unknown keys for newer builds; drop unreadable display activity without losing the offer. */
const agentSessionResumeMarkerSchema = z.object({
  sessionId: markerField,
  work: agentSessionResumeWorkSchema,
  latestUserItemId: markerField.nullable().optional(),
  recordedAt: z.number().int().nonnegative(),
  trigger: z.enum(AGENT_SESSION_RESUME_TRIGGERS),
  providerHandleRoot: markerField,
  teardownId: markerField,
  contextClearOperationId: markerField.optional().catch(undefined),
  journalCursor: z
    .object({ epoch: markerField, sequence: z.number().int().nonnegative() })
    .optional()
    .catch(undefined),
  activity: agentSessionRestartActivitySchema.optional().catch(undefined)
})

/** Malformed advisory markers drop as null, never throw and make sessions unreadable. */
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
