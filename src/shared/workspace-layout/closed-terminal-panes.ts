import { z } from 'zod'
import {
  CLOSED_TERMINAL_TAB_TOMBSTONE_TTL_MS as CLOSED_TERMINAL_PANE_TTL_MS,
  pruneClosedTerminalTabTombstones
} from './closed-terminal-tab-tombstones'

/** Remember layout-dropped panes until terminal exit can retire their records by PTY/incarnation. Main layout writes, exit cleanup reads; bound by TTL/per-host cap. Older builds ignore this. */
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
