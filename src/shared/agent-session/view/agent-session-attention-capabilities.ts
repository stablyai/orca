// Probe additive subscribeStatus support; structured.v1 hosts may lack it, causing endless reconnects without status.
export const AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY = 'agent-session.status-feed.v1' as const
// Probe completion separately: status-feed hosts may lack its opcode, which decoders silently drop.
export const AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY =
  'agent-session.turn-completion.v1' as const
// Probe additive acknowledgeAttention before sending read-chat acknowledgement to the host that pushed mobile alerts.
export const AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY =
  'agent-session.attention-ack.v1' as const

export const AGENT_SESSION_ATTENTION_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_STATUS_FEED_RUNTIME_CAPABILITY,
  AGENT_SESSION_TURN_COMPLETION_RUNTIME_CAPABILITY,
  AGENT_SESSION_ATTENTION_ACK_RUNTIME_CAPABILITY
] as const
