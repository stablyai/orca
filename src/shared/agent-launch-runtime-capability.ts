// Preserve spread order in protocol-version.ts; mobile recordings require direct imports rather than export *.

/** Negotiate host routing only with clients supporting both chat and terminal outcomes. Older clients retain worktree.create+startupAgent and require its terminal handle; silently routing those calls to chat breaks them. */
// v2 makes prompt delivery an outcome union and top-level warnings the only supported shape.
export const AGENT_LAUNCH_RUNTIME_CAPABILITY = 'agent.launch.v2' as const

// Optional identity support on agent.launch; mobile replay across replacement hosts requires the new method.
export const AGENT_LAUNCH_REPLAY_RUNTIME_CAPABILITY = 'agent.launch.replay.v1' as const

// Gate prompted launches: this host carries prompts outside typed startup lines to paste after readiness; older hosts inline them.
export const AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY = 'agent.launch.prompt-carry.v1' as const

// agent.launchReplay requires the ledger; older replacement hosts must reject the method.
export const AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY =
  'agent.launch.replay-required.v1' as const

// A client that reads `prompt.outcome: 'unconfirmed'` on a replayed launch. Without it, a launch
// whose host stopped mid-delivery replays as `agent_session_operation_unknown`, as it always has.
export const AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY =
  'agent.launch.prompt-unconfirmed.v1' as const

// Host-advertised: reads `placement` and `presentation`, reports the placement in the receipt, and
// may publish the launch's tab before it admits the launch.
export const AGENT_LAUNCH_PLACEMENT_RUNTIME_CAPABILITY = 'agent.launch.placement.v1' as const

// Host-advertised: presentation reaches local chat and terminal creation, including CLI launches.
export const AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY =
  'agent.launch.local-presentation.v1' as const

// Gate folder launch on this host capability plus folderWorkspace.create authorization; mobile scope lacks that permission.
export const AGENT_LAUNCH_CREATE_FOLDER_WORKSPACE_RUNTIME_CAPABILITY =
  'agent.launch.create-folder-workspace.v1' as const

// Client-advertised: unstarted tabs do not prove agent liveness; only these clients may see publication before spawn.
export const AGENT_LAUNCH_UNSTARTED_TAB_CLIENT_CAPABILITY = 'agent.launch.unstarted-tab.v1' as const

// Client-advertised: tab closure during startup is definite; older clients retain agent_session_operation_unknown.
export const AGENT_LAUNCH_TAB_CLOSED_CLIENT_CAPABILITY = 'agent.launch.tab-closed.v1' as const

export const AGENT_LAUNCH_SETTINGS_CAPABILITY = 'settings.agent-launch.v1' as const

// Host accepts scoped terminal permission mutations, including Auto.
export const AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY =
  'settings.agent-launch.auto-permissions.v1' as const

// Host accepts explicit native-chat synchronization without changing older terminal-only mutations.
export const AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY =
  'settings.agent-launch.native-chat-permissions.v1' as const

// Host stores each agent's permission apart from its Arguments: accepts `permission` and
// `user-arguments` and publishes `agentPermission`. Older hosts keep the permission in the text.
export const AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY = 'settings.agent-permission.v1' as const

// Host-advertised: reads `surface`, the user's chat or terminal pick for one launch, and refuses an
// explicit chat it cannot open before creating anything. Older hosts strip the field.
export const AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY = 'agent.launch.surface.v1' as const

export const AGENT_LAUNCH_RUNTIME_CAPABILITIES = [
  AGENT_LAUNCH_SETTINGS_CAPABILITY,
  AGENT_LAUNCH_AUTO_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_NATIVE_CHAT_PERMISSIONS_CAPABILITY,
  AGENT_LAUNCH_PERMISSION_CHOICE_CAPABILITY,
  AGENT_LAUNCH_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_REPLAY_REQUIRED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_CARRY_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PROMPT_UNCONFIRMED_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_PLACEMENT_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_LOCAL_PRESENTATION_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_CREATE_FOLDER_WORKSPACE_RUNTIME_CAPABILITY,
  AGENT_LAUNCH_SURFACE_RUNTIME_CAPABILITY
] as const
