/** Where a running agent takes a message: the terminal pane it runs in, or its structured chat. */
export type AgentMessageTarget =
  | { kind: 'terminal'; tabId: string; leafId: string }
  | { kind: 'structured-session'; sessionId: string }
