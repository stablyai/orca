// Why: a host's structured agents are the ones it registered, not a list every build ships. A host
// advertising this accepts any agent it lists through `agentSession.agents` (with each agent's
// capability record) in `agentSession.*` params, and refuses one it did not register; a client
// offers an agent beyond Claude and Codex only to such a host. A client advertising it renders an
// `agent-session` tab of any agent its host lists; the host withholds every other agent's tabs from
// a client that does not (an older client would list them with an empty pane).
export const STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY =
  'agent-session.structured.registered-agents.v1' as const
// Pi's dialog cards have a newer shape than the registered-agents reader alone promises.
// A client advertises this only after it can render and answer those cards.
export const PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY =
  'agent-session.structured.pi-dialogs.v1' as const
// Why: paired structured clients explicitly hold every visible session surface, allowing the host
// to stop provider children after the last surface closes without tying lifetime to a transport.
export const STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.hold.v1' as const
// Why: a client holding only a session id — an Agent Session History row — asks the host to
// republish that chat's tab. An older host has no such method, and a client must learn that during
// negotiation rather than by calling and reading a refusal it cannot distinguish from a real one.
export const STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY =
  'agent-session.structured.reveal.v1' as const
// Why: a client offers "Regenerate name" on a chat whose naming failed only to a host that has
// `agentSession.regenerateName`; an older host still publishes nothing a client must act on.
export const STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY =
  'agent-session.structured.regenerate-name.v1' as const
// Why: `agentSession.create` gains an optional `resumeFrom`, and its params are a STRICT union — an
// older host rejects the unknown key as a schema error, which a client cannot tell from a real
// refusal. Worse, without probing, a client cannot know whether a host that accepted the call
// adopted the conversation or quietly started a blank one. Negotiate before offering the action.
export const STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY =
  'agent-session.structured.resume-history.v1' as const

// Why: `agentSession.modelCatalog` takes `savedOnly`, an answer from what the host saved that starts
// no listing. Its params are strict, so an older host refuses the key; a client preloads every agent
// this way only from a host advertising this, and otherwise only agents with a saved pick.
export const AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY =
  'agent-session.model-catalog.saved-only.v1' as const

/** Strict create source identity is sent only after host negotiation. */
export const STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY =
  'agent-session.structured.cli-source.v1' as const
// Why: `agentSession.subscribeAvailability` is a new stream with strict params; a decoder drops an
// unknown opcode silently, so a client subscribes only to a host advertising this and otherwise
// shows its own facts, leaving the host's verdict to the click's createSupport.
export const STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY =
  'agent-session.structured.availability.v1' as const

export const STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES = [
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY,
  AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY
] as const
