import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from './qoder-terminal-create-capability'

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

export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
// Why: an older host drops session.tabs.close's `force` and refuses a pinned tab, so a client sends
// a confirmed pinned close's force only when advertised. Not behind a build switch: both builds honour it.
export const SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY = 'session-tabs.close-force.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// Why: a client advertising this retains every terminal retirement proof it receives until the
// surface is published live again, so a session-tabs stream sends each proof once instead of
// repeating the host's whole bounded list on every title tick.
export const SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY =
  'session-tabs.retirement-proof-delta.v1' as const
// Why: a client advertising this rebuilds each `updated` frame's tab list from the previous frame
// on the same stream, so one tab's status change no longer re-sends every tab in the worktree.
export const SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY = 'session-tabs.tab-delta.v1' as const
// Why: a client advertising this reads `restoredUnconfirmed` agent rows as unverifiable; older
// clients would read their last known state as live, so they keep the legacy `done` projection.
export const AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY =
  'agent-status.restored-unconfirmed.v1' as const

export const SESSION_TABS_RUNTIME_CAPABILITIES = [
  QODER_OWNED_TERMINAL_CREATE_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY,
  SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY,
  SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY
] as const
