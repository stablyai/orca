/** Derived display identity; never mailbox capabilities or structured-worker credential panes. */
export type AgentSenderAssociation = {
  address: string
  paneKey: string
  worktreeId: string
  sessionId?: string
}
export type AgentSenderPublication = {
  associations: readonly AgentSenderAssociation[]
  peerFingerprint?: string
  federation: readonly {
    dispatchId: string
    peerFingerprint: string
    homePeerFingerprint: string
  }[]
  attachments: readonly (AgentSenderAssociation & { homePeerFingerprint: string })[]
}
