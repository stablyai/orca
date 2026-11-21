import { usableAgentChildLabel } from '../../../agent-status/presentation/agent-child-row-name'
import { rolloutFileSizeAsync, type RolloutReadBatch } from './codex-rollout-async-reads'
import {
  readCodexSubagentIdentityAsync,
  type CodexSubagentIdentity
} from './codex-subagent-identity'
import {
  applyIdentityRead,
  identityReadTarget,
  type CodexSubagentRoster,
  type TrackedCodexSubagent
} from './codex-subagent-roster'

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

export type CodexSubagentIdentityRead = {
  id: string
  child: TrackedCodexSubagent
  transcriptPath: string
  missKey: string
  identity: CodexSubagentIdentity
}

/** Reads a few unnamed children's own rollouts per poll, taking turns, off the main thread; a relay restart can leave no parent transcript to drive this. */
export async function readPendingCodexSubagentIdentities(
  roster: CodexSubagentRoster,
  batch: RolloutReadBatch
): Promise<CodexSubagentIdentityRead[]> {
  const reads: CodexSubagentIdentityRead[] = []
  // Sequential reads keep one file operation per pane in flight.
  for (const [id, pending] of pendingIdentityTurn(roster)) {
    if (!batch.wanted()) {
      break
    }
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
    const size = await rolloutFileSizeAsync(transcriptPath, batch)
    if (!batch.wanted()) {
      break
    }
    const missKey = `${transcriptPath}:${size}`
    if (batch.deferrals.has(transcriptPath) || child.identityMissKey === missKey) {
      continue
    }
    const identity = await readCodexSubagentIdentityAsync(transcriptPath, id.trim(), batch)
    if (!batch.wanted()) {
      break
    }
    if (!batch.deferrals.has(transcriptPath)) {
      reads.push({ id, child, transcriptPath, missKey, identity })
    }
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
    // Parent records applied this poll may have named the child; its task path outranks the header.
    if (usableAgentChildLabel(child.description)) {
      child.identityPendingPath = undefined
      continue
    }
    changed = applyIdentityRead(child, missKey, transcriptPath, identity) || changed
  }
  return changed
}
