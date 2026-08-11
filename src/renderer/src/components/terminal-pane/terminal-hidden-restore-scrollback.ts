import {
  DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
  normalizeDesktopTerminalSnapshotRows
} from '../../../../shared/terminal-scrollback-policy'

/** Hidden view rebuilds must preserve the same history depth the live xterm
 * retained; otherwise switching tabs silently changes the user's scrollback. */
export function resolveHiddenRestoreScrollbackRows(configuredScrollback: unknown): number {
  return (
    normalizeDesktopTerminalSnapshotRows(configuredScrollback) ??
    DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  )
}
