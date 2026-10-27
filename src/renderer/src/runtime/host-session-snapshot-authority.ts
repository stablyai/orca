import {
  CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX,
  UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
} from '../../../shared/runtime-types'

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

/** Forced snapshots synthesize empty frames before publication, including after restart. UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH (with optional client navigation suffix) means ask later; absence cannot cull. Keep this separate from staleness so valid terminal reconciliation on the frame still applies. */
export function hostSnapshotAffirmsWorktreeContents(snapshot: SnapshotPublication): boolean {
  return (
    snapshot.publicationEpoch !== UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH &&
    snapshot.publicationEpoch !==
      `${UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH}${CLIENT_NAVIGATION_PUBLICATION_EPOCH_SUFFIX}`
  )
}

/** Browser authority is narrower than worktree authority: real restarted-runtime frames can omit pages clients still hold. clientHostedPagesUnreconciled withholds that verdict until bounded host reconciliation completes. */
export function hostSnapshotAffirmsClientHostedPages(
  snapshot: ClientHostedPagePublication
): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.clientHostedPagesUnreconciled
}

/** Chat authority is narrower than worktree authority: unreadable chat journals yield empty chat rows despite valid terminals. Absence cannot cull saved chat placement. */
export function hostSnapshotAffirmsAgentSessions(snapshot: AgentSessionPublication): boolean {
  return hostSnapshotAffirmsWorktreeContents(snapshot) && !snapshot.agentSessionsUnverifiable
}
