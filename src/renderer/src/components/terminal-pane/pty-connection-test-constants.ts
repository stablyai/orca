import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from '../../../../shared/terminal-mode-reset-profiles'

export const NORMAL_BUFFER_PROLOGUE = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue({ targetAlternateScreen: false, paneOnAlternateScreen: false })}`
export const UUID_RE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const AGENT_TASK_COMPLETE_NOTIFICATION_GRACE_MS = 250
export const AGENT_TASK_COMPLETE_NOTIFICATION_MAX_WAIT_MS = 1_500
export const VISIBLE_PTY_SETTLE_MS = 350
export const WRAPPER_RESOLVE_RETRY_MS = 1200
export const SECOND_WRAPPER_RETRY_MS = 6000
export const ANSI_POSITIONED_CURSOR_AGENT_REATTACH_SCREEN =
  '\x1b[4;3HCursor Agent\x1b[5;3Hv2026.06.29\x1b[9;3H→ Plan, search, build anything'
