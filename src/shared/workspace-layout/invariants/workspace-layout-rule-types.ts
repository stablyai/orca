import type { TerminalLeafOwner } from '../terminal-topology/terminal-owner-invariants'
import type { WorkspaceSessionPartitionId } from '../../workspace-session/teammate-homes-session-partition'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'

export type PaneOwner = Pick<
  TerminalLeafOwner,
  'hostId' | 'worktreeId' | 'leafId' | 'ptyId' | 'incarnationId'
> & { tab: { id: string } }

export type WorkspaceLayoutPartition = {
  hostId: WorkspaceSessionPartitionId
  session: WorkspaceSessionState
}

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
  | 'leaf_sleeping_and_resume'
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
  hostId: WorkspaceSessionPartitionId
  worktreeId?: string
  ids: string[]
  detail: string
}
