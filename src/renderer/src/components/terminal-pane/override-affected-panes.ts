// PTY events reach every subscriber, but numeric pane IDs are per-tab; resolve affected leaves through this tab’s live bindings.

import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

// Accept both a transport’s null ID and an unbound lookup’s undefined.
export type PanePtyResolver = (paneId: number) => string | null | undefined

export function getOverrideAffectedPanes(
  panes: readonly ManagedPane[],
  resolvePtyId: PanePtyResolver,
  ptyId: string
): ManagedPane[] {
  return panes.filter((pane) => resolvePtyId(pane.id) === ptyId)
}

function paneNeedsOverrideFit(
  pane: Pick<ManagedPane, 'terminal'>,
  cols: number,
  rows: number
): boolean {
  return pane.terminal.cols !== cols || pane.terminal.rows !== rows
}

export function getPanesNeedingOverrideFit(
  panes: readonly ManagedPane[],
  cols: number,
  rows: number
): ManagedPane[] {
  return panes.filter((pane) => paneNeedsOverrideFit(pane, cols, rows))
}
