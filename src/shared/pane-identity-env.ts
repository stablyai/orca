/**
 * Environment variables that name which pane and which launched execution a PTY belongs to.
 *
 * A pane that did not request these must not inherit them from the spawning process, so every
 * spawn path scrubs the same list. It lives here because the local provider and the daemon each
 * scrub independently, and a key added to one list and not the other stops being scrubbed at all.
 */
export const PANE_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_AGENT_STATUS_RUN_ID',
  'ORCA_AGENT_STATUS_EXECUTION_ID'
] as const
