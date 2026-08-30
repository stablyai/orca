import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'

/**
 * When each listed row was read, keyed by candidate identity.
 *
 * Why this exists rather than another comparison against `scannedAt`: recency is a
 * property of a ROW, and `scannedAt` is a property of a SCAN. The two stop agreeing
 * the moment the list holds rows from more than one read — which is exactly what a
 * post-confirmation republish does, and what a streamed progress tick does on
 * purpose, since it pins `scannedAt` to the snapshot's while writing newer rows. A
 * targeted rescan is also dated by its stalest chunk, so it is not even measured on
 * the same basis as a broad scan's single stamp.
 *
 * Every writer that replaces rows goes through one of the two functions below, and
 * both return the rows AND the reads together. That is deliberate: the round-five
 * regression was a writer that consulted this map without ever writing to it, and a
 * read time only one writer records is not a read time — it is a log of refusals.
 */
export type WorkspaceCleanupRowReads = Record<string, number>

/**
 * The single comparison the rule turns on: this read is stale FOR THIS ROW.
 *
 * Strictly newer, never equal: a scan's settle carries the same `scannedAt` as its
 * own progress ticks, so treating equal stamps as newer would make every settle
 * preserve its ticks and never publish its final rows.
 */
function hasNewerWorkspaceCleanupRowRead(
  identity: string,
  readAt: number,
  rowReads: WorkspaceCleanupRowReads
): boolean {
  const recorded = rowReads[identity]
  return recorded !== undefined && recorded > readAt
}

function pruneAndStamp(
  rowReads: WorkspaceCleanupRowReads,
  candidates: readonly WorkspaceCleanupCandidate[],
  stamp: (identity: string) => number | undefined
): WorkspaceCleanupRowReads {
  const next: WorkspaceCleanupRowReads = {}
  for (const candidate of candidates) {
    const identity = getWorkspaceCleanupCandidateIdentity(candidate)
    const readAt = stamp(identity)
    if (readAt !== undefined) {
      next[identity] = readAt
    }
  }
  const keys = Object.keys(next)
  return keys.length === Object.keys(rowReads).length &&
    keys.every((identity) => rowReads[identity] === next[identity])
    ? rowReads
    : next
}

/**
 * A whole-list replacement under the rule. Rows the list read later than this one
 * keep their picture and their read time; every row this read actually reported is
 * taken from it and stamped with it.
 *
 * `published` and `rows` differ for a streamed tick: the published list also carries
 * rows merged forward from earlier reads, and this read cannot vouch for those, so
 * they keep whatever stamp they already had.
 */
export function applyWorkspaceCleanupRowRead({
  rows,
  readAt,
  published,
  listed,
  rowReads
}: {
  rows: readonly WorkspaceCleanupCandidate[]
  readAt: number
  published: readonly WorkspaceCleanupCandidate[]
  listed: readonly WorkspaceCleanupCandidate[]
  rowReads: WorkspaceCleanupRowReads
}): { candidates: WorkspaceCleanupCandidate[]; rowReads: WorkspaceCleanupRowReads } {
  const newerListedRows = new Map<string, WorkspaceCleanupCandidate>()
  for (const row of listed) {
    const identity = getWorkspaceCleanupCandidateIdentity(row)
    if (hasNewerWorkspaceCleanupRowRead(identity, readAt, rowReads)) {
      newerListedRows.set(identity, row)
    }
  }
  // Identity-stable when nothing is preserved: a count-only tick must not hand
  // the list a new array and re-render every row.
  const candidates =
    newerListedRows.size === 0
      ? (published as WorkspaceCleanupCandidate[])
      : published.map(
          (row) => newerListedRows.get(getWorkspaceCleanupCandidateIdentity(row)) ?? row
        )
  const readIdentities = new Set(rows.map(getWorkspaceCleanupCandidateIdentity))
  return {
    candidates,
    rowReads: pruneAndStamp(rowReads, candidates, (identity) =>
      !newerListedRows.has(identity) && readIdentities.has(identity) ? readAt : rowReads[identity]
    )
  }
}

/**
 * A read that may rewrite or retire rows the list already holds, and may add none.
 *
 * The second half of the rule, and the one "most recent read wins" does not state
 * on its own: recency decides a row's EXISTENCE as well as its contents. Retiring
 * is a verdict read at a moment like any other, so a row whose newest read says it
 * is there — and busy — outranks an older read that did not list it. Without this
 * a live workspace disappears from the list, which is strictly worse than a stale
 * row: the user cannot even see the thing they are being asked about.
 */
export function rewriteWorkspaceCleanupRowsFromRead({
  listed,
  readAt,
  refreshed,
  retiredIdentities,
  rowReads
}: {
  listed: readonly WorkspaceCleanupCandidate[]
  readAt: number
  refreshed: readonly WorkspaceCleanupCandidate[]
  retiredIdentities: ReadonlySet<string>
  rowReads: WorkspaceCleanupRowReads
}): {
  candidates: WorkspaceCleanupCandidate[]
  rowReads: WorkspaceCleanupRowReads
  changed: boolean
} {
  const refreshedByIdentity = new Map(
    refreshed.map((candidate) => [getWorkspaceCleanupCandidateIdentity(candidate), candidate])
  )
  const rewrittenIdentities = new Set<string>()
  let changed = false
  const candidates = listed.flatMap((row) => {
    const identity = getWorkspaceCleanupCandidateIdentity(row)
    const next = refreshedByIdentity.get(identity)
    const retired = retiredIdentities.has(identity)
    if (!next && !retired) {
      return [row]
    }
    if (hasNewerWorkspaceCleanupRowRead(identity, readAt, rowReads)) {
      return [row]
    }
    changed = true
    // A row this read no longer lists has no refreshed picture to show, so
    // showing it again is the dead end; dropping it is the reconciliation.
    if (!next) {
      return []
    }
    rewrittenIdentities.add(identity)
    return [next]
  })
  return {
    candidates,
    changed,
    rowReads: pruneAndStamp(rowReads, candidates, (identity) =>
      rewrittenIdentities.has(identity) ? readAt : rowReads[identity]
    )
  }
}

/** Reads for rows no longer listed are dead weight, and a later row could inherit one. */
export function pruneWorkspaceCleanupRowReads(
  rowReads: WorkspaceCleanupRowReads,
  rows: readonly WorkspaceCleanupCandidate[]
): WorkspaceCleanupRowReads {
  return pruneAndStamp(rowReads, rows, (identity) => rowReads[identity])
}
