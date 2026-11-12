export type NativeChatOptimisticSendOutcome = {
  /** The host refused the write: mark the echo "Message not sent". */
  setSourceEvidence?: (pendingId: string, source: boolean) => void
  finishSourceEvidence?: (pendingId: string) => void
  reject: (pendingId: string) => void
  /** The write acknowledgment was lost: hold the echo, then flag it unconfirmed. */
  holdUnconfirmed: (pendingId: string) => void
}
