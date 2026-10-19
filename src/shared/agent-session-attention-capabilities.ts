// Why: agentSession.subscribeStatus is additive to a surface that already shipped, so a host
// advertising agent-session.structured.v1 may still answer it with method_not_found. Clients must
// probe before subscribing or they reconnect forever and never show any status at all.
export const AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY = 'agent-session.status-feed.v1' as const
// Why separate from the status feed: a host can carry the status feed and not this stream, and a
// decoder drops an unknown stream opcode in silence. A client that subscribed without probing
// would wait forever for completions the host never sends and report nothing wrong.
export const AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY =
  'agent-session.turn-completion.v1' as const
// Why: agentSession.acknowledgeAttention is additive; a client probes it before routing a read
// chat to the host that pushed its phone alerts, so an older host is never sent a method it lacks.
export const AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY =
  'agent-session.attention-ack.v1' as const

export const AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
] as const
