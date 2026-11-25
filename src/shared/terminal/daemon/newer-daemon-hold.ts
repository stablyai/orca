/** Spawn refusal marker: the requested session may still run in a newer Orca build's daemon. */
export const NEWER_DAEMON_HOLD_ERROR = 'terminal_held_by_newer_daemon'

export type NewerDaemonReopenResult = { reopened: boolean }

/** A held session's last saved screen, shown read-only until Reopen. */
export type NewerDaemonHeldScreen = { scrollback: string; cols: number; rows: number }
