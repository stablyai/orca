import { statSync } from 'node:fs'
import { stat } from 'node:fs/promises'

import {
  AGENT_MODEL_MAX_LENGTH,
  AGENT_STATUS_TOOL_INPUT_MAX_LENGTH,
  AGENT_TYPE_MAX_LENGTH,
  normalizeOptionalField
} from '../../../agent-status/contracts/agent-status-field-normalization'
import type { AgentSubagentSnapshot } from '../../../agent-status/contracts/agent-status-subagent-snapshot'

import {
  readCodexSubagentIdentity,
  readCodexSubagentIdentityAsync,
  type CodexSubagentIdentity
} from './codex-subagent-identity'
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
  identityTranscriptPath?: string
  /** The path whose first line holds no identity, or `path:size` while that line is unwritten; retried only on change. */
  identityMissKey?: string
  /** A hook-supplied rollout still owed an identity read; polls retry it without a parent transcript. */
  identityPendingPath?: string
  identityRetryAt?: number
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
    startedAt: now
  })
}

export function finishCodexSubagent(roster: CodexSubagentRoster, id: string): void {
  roster.delete(id.trim())
}

const IDENTITY_IO_RETRY_MS = 5_000

/** The child owed a read of `transcriptPath`, or undefined when no read is due. */
function identityReadTarget(
  roster: CodexSubagentRoster,
  id: string,
  transcriptPath: string | undefined
): TrackedCodexSubagent | undefined {
  const child = roster.get(id.trim())
  if (!child || !transcriptPath || child.identityTranscriptPath === transcriptPath) {
    return undefined
  }
  if (child.identityMissKey === transcriptPath) {
    return undefined
  }
  child.identityPendingPath = transcriptPath
  return (child.identityRetryAt ?? 0) > Date.now() ? undefined : child
}

function applyIdentityRead(
  child: TrackedCodexSubagent,
  missKey: string,
  transcriptPath: string,
  identity: CodexSubagentIdentity
): boolean {
  if (identity === 'unreadable') {
    child.identityRetryAt = Date.now() + IDENTITY_IO_RETRY_MS
    return false
  }
  child.identityRetryAt = undefined
  if (identity === 'pending') {
    child.identityMissKey = missKey
    return false
  }
  child.identityPendingPath = undefined
  if (!identity) {
    // A complete first line without this child's metadata never changes.
    child.identityMissKey = transcriptPath
    return false
  }
  child.identityTranscriptPath = transcriptPath
  child.identityMissKey = undefined
  const previous = child.description
  child.description =
    normalizeOptionalField(identity.description, AGENT_STATUS_TOOL_INPUT_MAX_LENGTH) ??
    child.description
  return child.description !== previous
}

/** Returns whether the child's name changed, so a poll that only recovered identity still publishes. */
export function enrichCodexSubagentIdentity(
  roster: CodexSubagentRoster,
  id: string,
  transcriptPath: string | undefined
): boolean {
  const child = identityReadTarget(roster, id, transcriptPath)
  if (!child || !transcriptPath) {
    return false
  }
  const missKey = `${transcriptPath}:${transcriptFileSize(transcriptPath)}`
  if (child.identityMissKey === missKey) {
    return false
  }
  return applyIdentityRead(
    child,
    missKey,
    transcriptPath,
    readCodexSubagentIdentity(transcriptPath, id.trim())
  )
}

/** Queue an unnamed child's own rollout for the bounded identity retries. */
export function queueCodexSubagentIdentity(
  roster: CodexSubagentRoster,
  id: string,
  transcriptPath: string
): void {
  const child = roster.get(id)
  if (
    child &&
    !usableAgentChildLabel(child.description) &&
    child.identityTranscriptPath !== transcriptPath &&
    child.identityMissKey !== transcriptPath
  ) {
    child.identityPendingPath = transcriptPath
  }
}

export function hasPendingCodexSubagentIdentity(roster: CodexSubagentRoster | undefined): boolean {
  return [...(roster?.values() ?? [])].some((child) => child.identityPendingPath !== undefined)
}

const IDENTITY_RETRIES_PER_POLL = 8
const identityRetryCursors = new WeakMap<CodexSubagentRoster, number>()

function pendingIdentityTurn(roster: CodexSubagentRoster): [string, TrackedCodexSubagent][] {
  const pending = [...roster].filter(([, child]) => child.identityPendingPath !== undefined)
  const start = (identityRetryCursors.get(roster) ?? 0) % Math.max(pending.length, 1)
  const turn = [...pending.slice(start), ...pending.slice(0, start)].slice(
    0,
    IDENTITY_RETRIES_PER_POLL
  )
  identityRetryCursors.set(roster, start + turn.length)
  return turn
}

type CodexSubagentIdentityRead = {
  id: string
  child: TrackedCodexSubagent
  transcriptPath: string
  missKey: string
  identity: CodexSubagentIdentity
}

/** Reads a few unnamed children's own rollouts per poll, taking turns, off the main thread; a relay restart can leave no parent transcript to drive this. */
export async function readPendingCodexSubagentIdentities(
  roster: CodexSubagentRoster
): Promise<CodexSubagentIdentityRead[]> {
  const reads: CodexSubagentIdentityRead[] = []
  // Sequential reads keep one file operation per pane in flight.
  for (const [id, pending] of pendingIdentityTurn(roster)) {
    // A task path the parent rollout supplied meanwhile outranks the child's own header.
    if (usableAgentChildLabel(pending.description)) {
      pending.identityPendingPath = undefined
      continue
    }
    const transcriptPath = pending.identityPendingPath
    const child = identityReadTarget(roster, id, transcriptPath)
    if (!child || !transcriptPath) {
      continue
    }
    const missKey = `${transcriptPath}:${await transcriptFileSizeAsync(transcriptPath)}`
    if (child.identityMissKey === missKey) {
      continue
    }
    const identity = await readCodexSubagentIdentityAsync(transcriptPath, id.trim())
    reads.push({ id, child, transcriptPath, missKey, identity })
  }
  return reads
}

/** Returns whether a child's name changed; reads for children a hook retired or re-pointed meanwhile are dropped. */
export function applyPendingCodexSubagentIdentities(
  roster: CodexSubagentRoster,
  reads: readonly CodexSubagentIdentityRead[]
): boolean {
  let changed = false
  for (const { id, child, transcriptPath, missKey, identity } of reads) {
    if (roster.get(id.trim()) !== child || child.identityPendingPath !== transcriptPath) {
      continue
    }
    changed = applyIdentityRead(child, missKey, transcriptPath, identity) || changed
  }
  return changed
}

function transcriptFileSize(transcriptPath: string): number | null {
  try {
    return statSync(transcriptPath).size
  } catch {
    return null
  }
}

async function transcriptFileSizeAsync(transcriptPath: string): Promise<number | null> {
  try {
    return (await stat(transcriptPath)).size
  } catch {
    return null
  }
}

/** Update only an existing child’s model, preserving lifecycle so late discovery cannot resurrect finished children. */
export function setCodexSubagentModel(
  roster: CodexSubagentRoster,
  id: string,
  model: string | undefined
): void {
  const normalizedModel = normalizeOptionalField(model, AGENT_MODEL_MAX_LENGTH)
  if (!normalizedModel) {
    return
  }
  const existing = roster.get(id.trim())
  if (!existing) {
    return
  }
  existing.model = normalizedModel
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
