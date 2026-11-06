// Cancel is strict and older hosts require turnId; advertised conversation-level Stop also works before a provider opens its turn.
export const AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY =
  'agent-session.conversation-stop.v1' as const
// Send prompt identity only to capable hosts; older strict schemas reject the whole cancel instead of falling back.
export const AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY =
  'agent-session.prompt-cancel.v1' as const
// This host keys Stop notes by turn and writes none for no-op stops. Older hosts add a false already-finished row, so clients join in-flight Stops until all supported hosts gain this.
export const AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY =
  'agent-session.repeated-stop.v1' as const

export const AGENT_SESSION_STOP_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_PROMPT_CANCEL_RUNTIME_CAPABILITY,
  AGENT_SESSION_REPEATED_STOP_RUNTIME_CAPABILITY
] as const
