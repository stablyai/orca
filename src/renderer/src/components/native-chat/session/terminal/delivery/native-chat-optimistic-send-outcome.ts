export type NativeChatOptimisticSendOutcome = {
  /** The host refused the write: mark the echo "Message not sent". */
  reject: (pendingId: string) => void
  /** The write acknowledgment was lost: hold the echo, then flag it unconfirmed. */
  holdUnconfirmed: (pendingId: string) => void
}
