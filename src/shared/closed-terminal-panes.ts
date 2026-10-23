import { z } from 'zod'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS as CLOSED_TERMINAL_PANE_TTL_MS,
  pruneClosedTerminalTabTombstones
} from './closed-terminal-tab-tombstones'

/** Main's record of a terminal pane its layout dropped, while the pane's terminal may still run.
 *
 *  Why it must exist: in a layout-owner build main's close removes the pane before its terminal
 *  exits, so the exit can no longer learn from the layout which pane's records it retires. Only
 *  main's layout write writes it; only exit cleanup reads it, by terminal id and incarnation both.
 *  It dies by TTL or the per-host cap, as closed-tab records do. Older builds ignore the field. */
export type ClosedTerminalPane = {
  ptyId: string
  incarnationId: string
  worktreeId: string
  closedAt: number
}

export type ClosedTerminalPanesByPaneKey = Record<string, ClosedTerminalPane>

export const closedTerminalPaneSchema = z.object({
  ptyId: z.string().min(1),
  incarnationId: z.string().min(1),
  worktreeId: z.string().min(1),
  closedAt: z.number().int().nonnegative()
})

export function recordClosedTerminalPanes(
  map: ClosedTerminalPanesByPaneKey | undefined,
  closed: Readonly<Record<string, Omit<ClosedTerminalPane, 'closedAt'>>>,
  now: number
): ClosedTerminalPanesByPaneKey {
  const next: ClosedTerminalPanesByPaneKey = { ...map }
  for (const [paneKey, pane] of Object.entries(closed)) {
    next[paneKey] = { ...pane, closedAt: now }
  }
  return pruneClosedTerminalTabTombstones(next, now)
}

/** The pane a terminal held when main's layout dropped it, within the TTL; null when none. */
export function closedTerminalPaneOf(
  map: ClosedTerminalPanesByPaneKey | undefined,
  ptyId: string,
  incarnationId: string,
  now = Date.now()
): (ClosedTerminalPane & { paneKey: string }) | null {
  for (const [paneKey, pane] of Object.entries(map ?? {})) {
    if (
      pane.ptyId === ptyId &&
      pane.incarnationId === incarnationId &&
      now - pane.closedAt <= CLOSED_TERMINAL_PANE_TTL_MS
    ) {
      return { ...pane, paneKey }
    }
  }
  return null
}
