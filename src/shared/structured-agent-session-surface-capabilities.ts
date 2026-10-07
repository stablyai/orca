// Why: a host's structured agents are the ones it registered, not a list every build ships. A host
// advertising this accepts any agent it lists through `agentSession.agents` (with each agent's
// capability record) in `agentSession.*` params, and refuses one it did not register; a client
// offers an agent beyond Claude and Codex only to such a host. A client advertising it renders an
// `agent-session` tab of any agent its host lists; the host withholds every other agent's tabs from
// a client that does not (an older client would list them with an empty pane).
export const STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY =
  'agent-session.structured.registered-agents.v1' as const
// Why: paired structured clients explicitly hold every visible session surface, allowing the host
// to stop provider children after the last surface closes without tying lifetime to a transport.
export const STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.hold.v1' as const
// Why: a client holding only a session id — an Agent Session History row — asks the host to
// republish that chat's tab. An older host has no such method, and a client must learn that during
// negotiation rather than by calling and reading a refusal it cannot distinguish from a real one.
export const STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY =
  'agent-session.structured.reveal.v1' as const
// Why: `agentSession.create` gains an optional `resumeFrom`, and its params are a STRICT union — an
// older host rejects the unknown key as a schema error, which a client cannot tell from a real
// refusal. Worse, without probing, a client cannot know whether a host that accepted the call
// adopted the conversation or quietly started a blank one. Negotiate before offering the action.
export const STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY =
  'agent-session.structured.resume-history.v1' as const

export const STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES = [
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY
] as const
