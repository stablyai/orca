/** Where a sender identity runs now: derived display data, never a mailbox address, handle or
 *  structured-worker credential pane. */
export type AgentSenderAssociation = {
  /** `conversation:<digest>`, `dispatch:<id>` or `orca_session_id:<id>`, as saved senders carry. */
  identity: string
  paneKey: string
  worktreeId: string
  sessionId?: string
}
export type AgentSenderPublication = {
  associations: readonly AgentSenderAssociation[]
  peerFingerprint?: string
  /** This host's principal as each paired execution peer authenticates it; one per peer. */
  principals: readonly { peerFingerprint: string; homePeerFingerprint: string }[]
  attachments: readonly (AgentSenderAssociation & { homePeerFingerprint: string })[]
}
