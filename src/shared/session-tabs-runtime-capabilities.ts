import { QODER_OWNED_TERMINAL_CREATE_CAPABILITY } from './qoder-terminal-create-capability'

// Complete split-parent placement agrees across headed/runtime-owned hosts; legacy clients must wait for the snapshot.
export const SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY =
  'session-tabs.split-group-placement.v1' as const
export const SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY =
  'session.tabs.chat-fork-cli.v1' as const
// Host will follow placeholder session-tabs answers with a published one (#25736); never wait for that on older hosts.
export const SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY =
  'session-tabs.empty-worktree-answer.v1' as const

// Gate shell picks because older hosts strip shell and spawn their default.
export const SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY =
  'session-tabs.create-terminal-shell.v1' as const

// Why: a host with this commits a client's pane-to-new-tab move (session.tabs.movePaneToNewTab).
// An older host keeps the pane where it was, so a client moves it only in its own window there.
export const SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY =
  'session-tabs.move-pane-to-new-tab.v1' as const

export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const
// Gate force on confirmed pinned closes; old hosts drop it and refuse. Both build variants honor it.
export const SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY = 'session-tabs.close-force.v1' as const
// Replay held closes as replay only where supported; old hosts accept user only.
export const SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY =
  'session-tabs.close-replay-reason.v1' as const
export const SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY =
  'session-tabs.authoritative-inventory.v1' as const
// Capable clients retain retirement proofs until live publication, allowing one send instead of full-list repetition on title ticks.
export const SESSION_TABS_RETIREMENT_PROOF_DELTA_RUNTIME_CAPABILITY =
  'session-tabs.retirement-proof-delta.v1' as const
// Capable clients reconstruct updated tabs from the same stream’s prior frame, avoiding whole-workspace resends.
export const SESSION_TABS_TAB_DELTA_RUNTIME_CAPABILITY = 'session-tabs.tab-delta.v1' as const
// Capable clients read restoredUnconfirmed as unverifiable; legacy clients need done to avoid claiming live state.
export const AGENT_STATUS_RESTORED_UNCONFIRMED_RUNTIME_CAPABILITY =
  'agent-status.restored-unconfirmed.v1' as const

// Why: only a WSL host advertises this, with session.readTerminalScrollback; a client asks for a
// pane's stored scrollback only when it is advertised and otherwise paints from its own store.
export const SESSION_TERMINAL_SCROLLBACK_READ_RUNTIME_CAPABILITY =
  'session.terminal-scrollback-read.v1' as const

export const SESSION_TABS_RUNTIME_CAPABILITIES = [
  QODER_OWNED_TERMINAL_CREATE_CAPABILITY,
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY,
  SESSION_TAB_CLOSE_REPLAY_REASON_RUNTIME_CAPABILITY,
  SESSION_TABS_AUTHORITATIVE_INVENTORY_RUNTIME_CAPABILITY,
  SESSION_TABS_SPLIT_GROUP_PLACEMENT_RUNTIME_CAPABILITY,
  SESSION_TABS_CHAT_FORK_CLI_RUNTIME_CAPABILITY,
  SESSION_TABS_EMPTY_WORKTREE_ANSWER_RUNTIME_CAPABILITY,
  SESSION_TABS_CREATE_TERMINAL_SHELL_RUNTIME_CAPABILITY,
  SESSION_TABS_MOVE_PANE_TO_NEW_TAB_RUNTIME_CAPABILITY
] as const
