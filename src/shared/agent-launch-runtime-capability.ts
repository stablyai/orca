// Split out of protocol-version.ts, which spreads the list below into RUNTIME_CAPABILITIES in this
// order. Import these names from here: the mobile recording loader cannot follow `export *`.

/**
 * `agent.launch` exists: one host-side method that decides structured-vs-terminal and creates the
 * surface, instead of each client routing for itself.
 *
 * Negotiated rather than assumed because a client that cannot see it must keep using
 * `worktree.create` + `startupAgent`, which stays supported verbatim. The reverse skew is the
 * dangerous one: `worktree.create` returns `agentTerminalHandle` only when a startup agent was
 * requested, so a host that quietly routed that call to a structured session would hand an old
 * client a response with no handle and no error.
 *
 * Advertising it is a statement that the client understands EITHER outcome, since the host is what
 * picks: a structured session it can open, or a terminal agent. A client that renders only one of
 * the two keeps using the surface-specific methods.
 */
// v2 makes prompt delivery an outcome union and top-level warnings the only supported shape.
export const AGENT_LAUNCH_RUNTIME_CAPABILITY = 'agent.launch.v2' as const

// Optional identity support on agent.launch; mobile replay across replacement hosts requires the new method.
export const AGENT_LAUNCH_REPLAY_RUNTIME_CAPABILITY = 'agent.launch.replay.v1' as const

// A host that sends a launch prompt its typed startup line cannot carry to a paste after
// readiness; an older host folds any prompt into that line, so clients gate prompted launches on it.
export const AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY = 'agent.launch.prompt-carry.v1' as const

// agent.launchReplay requires the ledger; older replacement hosts must reject the method.
export const AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY =
  'agent.launch.replay-required.v1' as const

export const AGENT_LAUNCH_RUNTIME_CAPABILITIES = [
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY
] as const
