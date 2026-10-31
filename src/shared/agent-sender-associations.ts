/** Where a sender a card saved runs now: derived display data, never a structured-worker
 *  credential pane. */
export type AgentSenderAssociation = {
  /** The terminal handle, `dispatch:<id>` or `orca_session_id:<id>` a saved sender carries. */
  identity: string
  paneKey: string
  worktreeId: string
  sessionId?: string
}
/** Which host publication a delivery was cut from: the publishing runtime's epoch and the content
 *  revision the whole host, or one worktree's scope, last changed at. In memory only. */
export type AgentSenderRevision = { epoch: string; revision: number }
export type AgentSenderPublication = {
  associations: readonly AgentSenderAssociation[]
  peerFingerprint?: string
  /** This host's principal as each paired execution peer authenticates it; one per peer. */
  principals: readonly { peerFingerprint: string; homePeerFingerprint: string }[]
  attachments: readonly (AgentSenderAssociation & { homePeerFingerprint: string })[]
  /** Absent from hosts that predate revisions; such a delivery is always complete. */
  revision?: AgentSenderRevision
}
