import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'

import { codexSubagentIdentityFromHead } from './codex-subagent-identity'
import type { JsonRecord } from './codex-rollout-jsonl-format'
import type { CodexApprovalHold } from './codex-rollout-state'
import { usableAgentChildLabel } from '../../../agent-status/presentation/agent-child-row-name'
import {
  agentChildWorkLiveness,
  type AgentChildWorkLiveness
} from '../../../agent-status/child-work/agent-status-child-work-liveness'

const CODEX_SUBAGENT_ID_MAX_LENGTH = 64

export type CodexSubagentRoster = Map<string, TrackedCodexSubagent>

type TrackedCodexSubagent = {
  agentType?: string
  description?: string
  model?: string
  state: 'working' | 'waiting'
  startedAt: number
  /** The child's own rollout, still owed one async first-line read for its name. */
  identityPath?: string
  identityReading?: boolean
  identityRetryAt?: number
  identityAttempts?: number
  /** A rollout whose first line was already read to a final answer. */
  identityReadPath?: string
  /** A live hook named this child in this process; restored rows lack it. */
  observed?: true
  /** Hooks seen for this child; a rollout end read before the latest one is stale. */
  hooks: number
  lastHookAt?: number
  /** The child's own rollout, followed for turn ends no hook reports. */
  rolloutPath?: string
  approvalHold?: CodexApprovalHold
  /** Relay session whose own roster listed this child; only that session may retire it by omission. */
  reportedBy?: string
}

export function upsertCodexSubagent(
  roster: CodexSubagentRoster,
  id: string,
  fields: {
    agentType?: string
    description?: string
    model?: string
    state: 'working' | 'waiting'
  },
  now: number
): void {
  const normalizedId = id.trim()
  if (normalizedId.length === 0 || normalizedId.length > CODEX_SUBAGENT_ID_MAX_LENGTH) {
    return
  }
  const agentType = normalizeOptionalField(fields.agentType, AGENT_TYPE_MAX_LENGTH)
  const description = normalizeOptionalField(fields.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH)
  const model = normalizeOptionalField(fields.model, AGENT_MODEL_MAX_LENGTH)
  const existing = roster.get(normalizedId)
  if (existing) {
    existing.agentType = agentType ?? existing.agentType
    existing.description = description ?? existing.description
    existing.model = model ?? existing.model
    existing.state = fields.state
    return
  }
  roster.set(normalizedId, {
    agentType,
    description,
    model,
    state: fields.state,
    startedAt: now,
    hooks: 0
  })
}

export function finishCodexSubagent(roster: CodexSubagentRoster, id: string): void {
  roster.delete(id.trim())
}

const IDENTITY_IO_RETRY_MS = 5_000
const IDENTITY_PENDING_RETRY_MS = 1_000
const IDENTITY_READS_PER_PASS = 8
// A rollout that never gains a first line stays unnamed rather than being retried forever.
const IDENTITY_MAX_ATTEMPTS = 5

/** A live hook for this child: it is real in this process, and its PostToolUse answers the approval it asked. */
export function markCodexSubagentHookEvidence(
  roster: CodexSubagentRoster,
  id: string,
  hook: { now: number; rolloutPath?: string; answeredToolKey?: string }
): void {
  const child = roster.get(id.trim())
  if (!child) {
    return
  }
  child.observed = true
  child.hooks += 1
  child.lastHookAt = hook.now
  child.rolloutPath ??= hook.rolloutPath
  if (hook.answeredToolKey !== undefined && child.approvalHold?.toolKey === hook.answeredToolKey) {
    child.approvalHold = undefined
  }
}

/** Queue an unnamed child's own rollout for one async first-line read. */
export function queueCodexSubagentIdentity(
  roster: CodexSubagentRoster,
  id: string,
  transcriptPath: string | undefined
): void {
  const child = roster.get(id.trim())
  if (
    child &&
    transcriptPath &&
    !usableAgentChildLabel(child.description) &&
    child.identityReadPath !== transcriptPath &&
    child.identityPath !== transcriptPath
  ) {
    child.identityPath = transcriptPath
    child.identityRetryAt = undefined
    child.identityAttempts = 0
  }
}

/** Children whose name read may start now, a few per pass. */
export function takeCodexSubagentIdentityReads(
  roster: CodexSubagentRoster,
  now: number
): { id: string; filePath: string }[] {
  const reads: { id: string; filePath: string }[] = []
  for (const [id, child] of roster) {
    if (reads.length >= IDENTITY_READS_PER_PASS) {
      break
    }
    if (child.identityPath && !child.identityReading && (child.identityRetryAt ?? 0) <= now) {
      child.identityReading = true
      reads.push({ id, filePath: child.identityPath })
    }
  }
  return reads
}

/** Apply a finished name read; returns whether the row changed. Dropped when the child finished or moved to another rollout meanwhile. */
export function applyCodexSubagentIdentityRead(
  roster: CodexSubagentRoster,
  id: string,
  filePath: string,
  head: JsonRecord | 'pending' | 'unreadable' | undefined,
  now: number
): boolean {
  const child = roster.get(id)
  if (!child) {
    return false
  }
  child.identityReading = false
  if (child.identityPath !== filePath) {
    return false
  }
  child.identityAttempts = (child.identityAttempts ?? 0) + 1
  if (
    (head === 'pending' || head === 'unreadable') &&
    child.identityAttempts < IDENTITY_MAX_ATTEMPTS
  ) {
    child.identityRetryAt =
      now + (head === 'pending' ? IDENTITY_PENDING_RETRY_MS : IDENTITY_IO_RETRY_MS)
    return false
  }
  child.identityPath = undefined
  child.identityRetryAt = undefined
  child.identityReadPath = filePath
  const description = normalizeOptionalField(
    codexSubagentIdentityFromHead(typeof head === 'string' ? undefined : head, id)?.description,
    AGENT_STATUS_TOOL_INPUT_MAX_LENGTH
  )
  if (
    !description ||
    usableAgentChildLabel(child.description) ||
    description === child.description
  ) {
    return false
  }
  child.description = description
  return true
}

/** When the next deferred name read is due, if any. */
export function nextCodexSubagentIdentityRetry(
  roster: CodexSubagentRoster | undefined
): number | undefined {
  let due: number | undefined
  for (const child of roster?.values() ?? []) {
    if (child.identityPath && !child.identityReading && child.identityRetryAt !== undefined) {
      due = due === undefined ? child.identityRetryAt : Math.min(due, child.identityRetryAt)
    }
  }
  return due
}

/** Restored children no live hook confirmed cannot outlive the root turn that ends without them. */
export function retireUnobservedCodexSubagents(roster: CodexSubagentRoster): void {
  for (const [id, child] of roster) {
    if (!child.observed) {
      roster.delete(id)
    }
  }
}

export function seedCodexSubagentRoster(
  roster: CodexSubagentRoster,
  snapshots: readonly AgentSubagentSnapshot[],
  reportedBy?: string
): void {
  for (const snapshot of snapshots) {
    if (snapshot.state !== 'working' && snapshot.state !== 'waiting') {
      continue
    }
    upsertCodexSubagent(
      roster,
      snapshot.id,
      {
        agentType: snapshot.agentType,
        description: snapshot.description,
        model: snapshot.model,
        state: snapshot.state
      },
      snapshot.startedAt
    )
    const tracked = reportedBy ? roster.get(snapshot.id.trim()) : undefined
    if (tracked) {
      tracked.reportedBy = reportedBy
    }
  }
}

export function codexRosterToSnapshots(
  roster: CodexSubagentRoster | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!roster || roster.size === 0) {
    return undefined
  }
  const snapshots = Array.from(roster, ([id, tracked]) => ({
    id,
    agentType: tracked.agentType,
    description: tracked.description,
    model: tracked.model,
    state: tracked.state,
    startedAt: tracked.startedAt
  }))
  snapshots.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id, 'en'))
  return snapshots
}

/** Project spawned agent threads through the shared kind policy: waiting/working child evidence, never watch loops. */
export function codexRosterChildWorkLiveness(
  roster: CodexSubagentRoster | undefined
): AgentChildWorkLiveness {
  return agentChildWorkLiveness(
    roster
      ? Array.from(roster.values(), (tracked) => ({ kind: 'agent' as const, state: tracked.state }))
      : undefined
  )
}
