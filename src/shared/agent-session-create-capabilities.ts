// `agentSession.create` is a strict object, so an older host refuses a payload carrying a field it
// does not know rather than ignoring it. A client sends each only to a host advertising it.

/** The reserved `tabId`. */
export const AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY =
  'agentSession.create.tab-id.v1' as const

/** `forkFrom`: "fork from this turn" is offered only for a chat whose host advertises this. */
export const AGENT_SESSION_FORK_RUNTIME_CAPABILITY = 'agent-session.fork.v1' as const

export const AGENT_SESSION_CREATE_RUNTIME_CAPABILITIES = [
  AGENT_SESSION_CREATE_TAB_ID_RUNTIME_CAPABILITY,
  AGENT_SESSION_FORK_RUNTIME_CAPABILITY
] as const
