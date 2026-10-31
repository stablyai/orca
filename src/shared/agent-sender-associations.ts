/** Where a sender a card saved runs now: derived display data, never a structured-worker
 *  credential pane. */
export type AgentSenderAssociation = {
  /** The terminal handle, `dispatch:<id>` or `orca_session_id:<id>` a saved sender carries. */
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
