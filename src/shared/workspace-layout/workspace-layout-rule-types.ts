import type { TerminalLeafOwner } from './terminal-owner-invariants'
import type { ExecutionHostId } from '../execution-host'
import type { WorkspaceSessionState } from '../workspace-session-state-types'

/** A pane as the pane rules see it, from the disk format or the model. */
export type PaneOwner = Pick<
  TerminalLeafOwner,
  'hostId' | 'worktreeId' | 'leafId' | 'ptyId' | 'incarnationId'
> & { tab: { id: string } }

export type WorkspaceLayoutPartition = { hostId: ExecutionHostId; session: WorkspaceSessionState }

export type WorkspaceLayoutRule =
  | 'terminal_in_two_panes'
  | 'pane_in_two_tabs'
  | 'pane_twice_in_one_tab'
  | 'pane_without_tab'
  | 'binding_without_pane'
  | 'tab_in_two_places'
  | 'tab_bar_missing'
  | 'tab_without_group'
  | 'group_empty'
  | 'group_tree_mismatch'
  | 'leaf_without_pane'
  | 'tab_in_two_groups'
  | 'tab_group_mismatch'
  | 'group_lists_missing_tab'
  | 'tab_lists_disagree'
  | 'tab_order_disagrees'
  | 'pane_id_changed'
  | 'tab_id_changed'
  | 'group_id_changed'

export type WorkspaceLayoutViolation = {
  rule: WorkspaceLayoutRule
  hostId: ExecutionHostId
  worktreeId?: string
  ids: string[]
  detail: string
}
