// Create is strict: send reserved tabId only to hosts advertising support.
export const AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY =
  'agentSession.create.tab-id.v1' as const
// Create is strict: advertise tabPlacement before sending it; the host saves its own group/tab IDs for the paired client (L270).
export const AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY =
  'agentSession.create.tab-placement.v1' as const
// Create is strict: this capability lets the host own the first message from creation.
export const AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY =
  'agentSession.create.message.v1' as const

// Send is strict: advertise options before sending model/effort choices for the new turn and chat record.
export const AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY =
  'agent-session.send-options.v1' as const

// Terminal create/ensure are strict: send accountEnv only to hosts advertising support.
export const AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY = 'agent-session.account-env.v1' as const

// Why: `agentSession.create` is a strict object, so an older host refuses `optionsMode`. A host
// advertising this replaces a chat's model selection with explicit launch options.
export const AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY =
  'agentSession.create.options-mode.v1' as const

// Send is strict: advertise skills before sending selected paths; name-based agents still use the $name text.
export const AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY = 'agent-session.send-skills.v1' as const

// Ensure is strict: send a resumed Claude session's effort only to hosts advertising support.
export const AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY =
  'agent-session.resume-effort.v1' as const

export const AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY =
  'agent-session.send-usage-limit-continuation.v1' as const

export const AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY =
  'agent-session.send-selection.v1' as const

export const AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_SEND_SELECTION_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_USAGE_LIMIT_CONTINUATION_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_MESSAGE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_OPTIONS_MODE_RUNTIME_CAPABILITY,
  AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_OPTIONS_RUNTIME_CAPABILITY,
  AGENT_SESSION_ACCOUNT_ENV_RUNTIME_CAPABILITY,
  AGENT_SESSION_SEND_SKILLS_RUNTIME_CAPABILITY,
  AGENT_SESSION_RESUME_EFFORT_RUNTIME_CAPABILITY
] as const
