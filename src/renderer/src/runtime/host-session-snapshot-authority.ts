import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'

type SnapshotPublication = {
  publicationEpoch: string
  snapshotVersion: number
}

type ClientHostedPagePublication = SnapshotPublication & {
  clientHostedPagesUnreconciled?: true
}

type AgentSessionPublication = SnapshotPublication & {
  agentSessionsUnverifiable?: true
}

/**
 * Whether a session-tabs snapshot carries the host's answer about a worktree at all.
 *
 * A runtime that has published nothing for a worktree still answers a forced snapshot, with a
 * synthesized empty frame. Every worktree is in that state for a moment after the host process
 * restarts, and the frame is indistinguishable from "the user closed everything" unless the epoch
 * is read: `UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH` at version 0 is the runtime saying "ask me
 * later". Absence in such a frame proves nothing, so it must not drive a cull.
 *
 * Deliberately not part of the staleness gate: the frame is not stale, and rejecting it outright
 * would also drop the terminal reconciliation that legitimately rides on it.
 */
export function hostSnapshotAffirmsWorktreeContents(snapshot: SnapshotPublication): boolean {
  return !(
    snapshot.publicationEpoch === UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH &&
    snapshot.snapshotVersion === 0
  )
}

/**
 * Whether a snapshot's browser rows are the host's answer about this desktop's client-hosted pages.
 *
 * Narrower than {@link hostSnapshotAffirmsWorktreeContents} on purpose. A restarted runtime rebuilds
 * terminals from disk and publishes a real, versioned frame under a real epoch — authoritative for
 * everything it owns, but silently missing the client-hosted pages it has not yet taken back from
 * the hosts still holding them. `clientHostedPagesUnreconciled` is the host saying so, and the
 * runtime bounds it, so trusting it cannot strand a row indefinitely.
 */
export function hostSnapshotAffirmsClientHostedPages(
  snapshot: ClientHostedPagePublication
): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.clientHostedPagesUnreconciled
}

/**
 * Whether a snapshot's `agent-session` rows are the host's answer about which chats exist.
 *
 * Narrower than {@link hostSnapshotAffirmsWorktreeContents} for the same reason as client-hosted
 * pages: a runtime whose chat journal will not open is authoritative about terminals but cannot
 * list a single chat. Its empty chat set is "cannot tell", and culling on it would delete tabs
 * whose chats are safe on disk.
 */
export function hostSnapshotAffirmsAgentSessions(snapshot: AgentSessionPublication): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.agentSessionsUnverifiable
}
