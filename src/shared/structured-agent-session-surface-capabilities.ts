import { AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY } from './agent-session-permission-modes-capability'
// Registered-agent hosts accept only their agentSession.agents inventory; offer agents beyond Claude/Codex only after negotiation.
// Clients advertising this can render those agents’ tabs; withhold extra-agent tabs from older clients to avoid empty panes.
export const STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY =
  'agent-session.structured.registered-agents.v1' as const
// Pi dialog rendering/answers require a capability beyond registered-agent support.
export const PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY =
  'agent-session.structured.pi-dialogs.v1' as const
// Explicit surface holds let hosts stop children after the last visible surface closes, independently of transports.
export const STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY =
  'agent-session.structured.hold.v1' as const
// Gate session-history tab reveal: old hosts lack the method, and its refusal is indistinguishable from a real failure.
export const STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY =
  'agent-session.structured.reveal.v1' as const
// Offer Regenerate name only to hosts implementing agentSession.regenerateName.
export const STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY =
  'agent-session.structured.regenerate-name.v1' as const
// Save names only on rename-capable hosts; older hosts retain the local tab alias.
export const STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY =
  'agent-session.structured.rename.v1' as const
// Negotiate resumeFrom before sending: old strict create schemas reject it, while unproven acceptance could silently start a blank chat.
export const STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY =
  'agent-session.structured.resume-history.v1' as const

// Gate savedOnly because old strict catalog params reject it; otherwise preload only agents with saved picks.
export const AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY =
  'agent-session.model-catalog.saved-only.v1' as const

/** Strict create source identity is sent only after host negotiation. */
export const STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY =
  'agent-session.structured.cli-source.v1' as const
// Gate the availability stream because old decoders silently drop its opcode; fall back to client facts/createSupport on click.
export const STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY =
  'agent-session.structured.availability.v1' as const

export const AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY =
  'agent-session.coherent-model-catalog.v1' as const

export const STRUCTURED_AGENT_SESSION_SURFACE_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_PERMISSION_OWN_RUNTIME_CAPABILITY,
  AGENT_SESSION_COHERENT_MODEL_CATALOG_CAPABILITY,
  STRUCTURED_AGENT_SESSION_HOLD_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY,
  PI_STRUCTURED_DIALOGS_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RESUME_HISTORY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY,
  AGENT_SESSION_MODEL_CATALOG_SAVED_ONLY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_REGENERATE_NAME_RUNTIME_CAPABILITY,
  STRUCTURED_AGENT_SESSION_RENAME_RUNTIME_CAPABILITY
] as const
