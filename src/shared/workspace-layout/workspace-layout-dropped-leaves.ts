// The one step every layout commit runs over the panes it dropped (layout-owner builds), so no
// close path (phone, CLI by handle, window, headless) retires its panes on its own.
import { recordClosedTerminalPanes, type ClosedTerminalPane } from '../closed-terminal-panes'
import type { ExecutionHostId } from '../execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../layout-owner-switch'
import type { DroppedLeafReason } from './workspace-layout-command-types'
import { leafIdsOf } from './workspace-layout-command-steps'
import {
  paneKeyOf,
  type WorkspaceLayout,
  type WorkspaceLayoutModel
} from './workspace-layout-model'

/** A pane the commit removed whose terminal no pane holds any more. */
export type DroppedLeaf = {
  /** The partition the pane was in: the host that runs its terminal and stops it. */
  hostId: ExecutionHostId
  worktreeId: string
  tabId: string
  leafId: string
  ptyId: string
  /** Absent for a pane bound before incarnations were recorded. */
  incarnationId?: string
}

function* boundLeaves(
  workspace: WorkspaceLayout
): Generator<Omit<DroppedLeaf, 'hostId' | 'worktreeId'>> {
  for (const tab of workspace.tabs) {
    for (const leafId of tab.kind === 'terminal' ? leafIdsOf(tab) : []) {
      const leaf = workspace.leaves?.[leafId]
      if (leaf?.ptyId) {
        yield {
          tabId: tab.entityId,
          leafId,
          ptyId: leaf.ptyId,
          ...(leaf.incarnationId ? { incarnationId: leaf.incarnationId } : {})
        }
      }
    }
  }
}

const terminalKey = (leaf: Pick<DroppedLeaf, 'ptyId' | 'incarnationId'>): string =>
  `${leaf.ptyId}\0${leaf.incarnationId ?? ''}`

/** Panes bound in `before` whose leaf `after` no longer has, and whose terminal no pane holds. */
export function droppedLeavesOf(
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel
): DroppedLeaf[] {
  const held = new Set<string>()
  for (const workspace of Object.values(after.workspaces)) {
    for (const leaf of boundLeaves(workspace)) {
      held.add(terminalKey(leaf))
    }
  }
  const dropped: DroppedLeaf[] = []
  for (const [key, workspace] of Object.entries(before.workspaces)) {
    if (after.workspaces[key] === workspace) {
      continue
    }
    for (const leaf of boundLeaves(workspace)) {
      if (!after.workspaces[key]?.leaves?.[leaf.leafId] && !held.has(terminalKey(leaf))) {
        dropped.push({ ...leaf, hostId: before.hostId, worktreeId: workspace.worktreeId })
      }
    }
  }
  return dropped
}

/** What a live edit does with the panes it dropped: records each terminal's pane for its exit. */
export function onDroppedLeaves(
  model: WorkspaceLayoutModel,
  dropped: readonly DroppedLeaf[],
  _reason: DroppedLeafReason,
  now: number
): WorkspaceLayoutModel {
  // A retry or a second commit of the same drop records it once: keyed by terminal, not pane.
  const recorded = new Set(
    Object.values(model.records.closedTerminalPanesByPaneKey ?? {}).map(terminalKey)
  )
  const closed: Record<string, Omit<ClosedTerminalPane, 'closedAt'>> = {}
  for (const { worktreeId, tabId, leafId, ptyId, incarnationId } of dropped) {
    if (incarnationId && !recorded.has(terminalKey({ ptyId, incarnationId }))) {
      closed[paneKeyOf(tabId, leafId)] = { ptyId, incarnationId, worktreeId }
    }
  }
  if (Object.keys(closed).length === 0) {
    return model
  }
  const records = model.records
  const closedTerminalPanesByPaneKey = recordClosedTerminalPanes(
    records.closedTerminalPanesByPaneKey,
    closed,
    now
  )
  return { ...model, records: { ...records, closedTerminalPanesByPaneKey } }
}

/** Switch point: runs the dropped-leaf step on a live edit; window-owned builds have none. */
export function runDroppedLeafStep(
  before: WorkspaceLayoutModel,
  after: WorkspaceLayoutModel,
  reason: DroppedLeafReason,
  now: number
): WorkspaceLayoutModel {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN || before.workspaces === after.workspaces) {
    return after
  }
  return onDroppedLeaves(after, droppedLeavesOf(before, after), reason, now)
}
