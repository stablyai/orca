// Why: this proves both headed and runtime-owned host paths place after a complete split parent.
// Legacy host paths disagree, so clients without this capability defer placement to the snapshot.
export const SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY =
  'session-tabs.split-group-placement.v1' as const
export const SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY =
  'session.tabs.chat-fork-cli.v1' as const
// Why: a host with this follows an "ask me later" session-tabs answer with a real one once its graph
// publishes (#25736). Older hosts never do, so a client must not wait on that answer from them.
export const SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY =
  'session-tabs.empty-worktree-answer.v1' as const

// Why: an older host strips session.tabs.createTerminal's unknown `shell` and spawns its default
// shell, so a client sends the pick there only when advertised.
export const SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY =
  'session-tabs.create-terminal-shell.v1' as const

export const SESSION_TABS_RUNTIME_CAPABILITIES = [
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY,
  SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY,
  SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY
] as const
