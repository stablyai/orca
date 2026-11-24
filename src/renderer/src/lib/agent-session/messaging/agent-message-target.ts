export type AgentMessageTarget =
  | { kind: 'terminal'; tabId: string; leafId: string }
  | { kind: 'structured-session'; sessionId: string }
