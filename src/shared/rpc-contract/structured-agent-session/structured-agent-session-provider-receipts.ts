/** Opt-in subscription frames with an independent revision and no transcript cursor. */
export type AgentSessionProviderReceiptFrame = {
  type: 'provider-receipts'
  sessionId: string
  hostIncarnation: string
  /** New for each stream, including reconnects to the same host and journal epoch. */
  subscription: string
  revision: number
  replace: boolean
  updates: ProviderReceiptUpdate[]
}

export type ProviderReceiptUpdate = {
  clientMessageId: string
  /** Null removes a previous stamp; a replacement frame contains only current stamps. */
  observedAt: number | null
}
