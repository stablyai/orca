// The capabilities that gate what an `agentSession.cancel` may carry and what a Stop writes.

// Why: `agentSession.cancel` params are strict and older hosts require `turnId`. A host advertising
// this takes a cancel naming no turn as "stop what the conversation has in flight", which is the
// only Stop a client can send before the provider has opened a turn.
export const AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY =
  'agent-session.conversation-stop.v1' as const
// Why: agentSession.cancel has a strict schema, so clients must not send prompt identity to an
// older host that would reject the whole cancellation instead of falling back to turn stop.
export const AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY =
  'agent-session.prompt-cancel.v1' as const
// Why: a Stop that stopped nothing adds no row on this host, and its note is keyed by turn. An older
// host has the second write a false "already finished" row, so a client joins a Stop still on its
// way itself there. Transitional: drop the client join once no supported host lacks this.
export const AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY =
  'agent-session.repeated-stop.v1' as const
export const AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY =
  'agent-session.targeted-stop.v1' as const

export const AGENT_SESSION_STOP_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_TARGETED_STOP_RUNTIME_CAPABILITY
] as const
