// `orchestration.turnSender`: an agent asks orcad which paired device sent the message that started
// its latest turn. orcad identifies the asking agent from its own launch evidence, never params.
export const TURN_SENDER_METHOD = 'orchestration.turnSender'

export type TurnSenderResult = {
  /** The asking agent, as orcad proved it. */
  caller: { kind: 'session'; sessionId: string } | { kind: 'terminal'; handle: string } | null
  /** The paired device whose message started the agent's latest turn; null when none was recorded. */
  sender: { deviceId: string; at: number } | null
}
