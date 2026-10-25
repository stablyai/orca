// What a workspace's records frames changed since the store last showed it, kept per record so a
// flush shows only those records: panes' terminal bindings and live titles apply alone; any other
// record kind takes a workspace build.

import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import type { WorkspaceLayoutRecordsFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import type {
  PublishedPane,
  PublishedTab,
  PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import type {
  PublishedPaneTree,
  WorkspaceLayoutRecordChange
} from '../../../shared/workspace-layout/workspace-layout-records'

export type PendingWorkspaceChanges = {
  /** Tab rows, the tab set or order, groups, a pane tree's shape, editor files or browser tabs. */
  rebuild: boolean
  /** Terminal entity id → the tab as the store last showed it, for tabs whose live titles changed. */
  titled: Map<string, PublishedTab>
  /** Terminal entity ids whose panes' bindings changed. */
  rebound: Set<string>
}

/** The workspace's pending changes, started empty. */
export function pendingWorkspaceChanges(
  pending: Map<string, PendingWorkspaceChanges>,
  key: string
): PendingWorkspaceChanges {
  let changes = pending.get(key)
  if (!changes) {
    changes = { rebuild: false, titled: new Map(), rebound: new Set() }
    pending.set(key, changes)
  }
  return changes
}

/** A pane tree without its panes' live titles or bindings. */
function unboundPaneTreeJson(
  tree: Pick<PublishedPaneTree, 'root' | 'chatLeafId' | 'panes'>
): string {
  return stableJson({
    root: tree.root,
    chatLeafId: tree.chatLeafId,
    panes: tree.panes.map(
      ({
        liveTitle: _liveTitle,
        ptyId: _ptyId,
        ptyGeneration: _ptyGeneration,
        ...pane
      }: PublishedPane) => pane
    )
  })
}

function tabOwningLeaf(
  layouts: readonly PublishedWorkspaceLayout[],
  leafId: string
): PublishedTab | undefined {
  for (const layout of layouts) {
    const tab = layout.tabs.find((candidate) =>
      candidate.terminal?.panes.some((pane) => pane.leafId === leafId)
    )
    if (tab) {
      return tab
    }
  }
  return undefined
}

/** Adds one records change to what `pending` holds; `before` is the cache's copy it applied to. */
function notePendingRecordChange(
  pending: PendingWorkspaceChanges,
  before: PublishedWorkspaceLayout,
  after: PublishedWorkspaceLayout,
  change: Extract<WorkspaceLayoutRecordChange, { change: 'records' }>
): void {
  if (change.workspace || change.tabs || change.editorFiles || change.browserTabs) {
    pending.rebuild = true
  }
  if (change.paneTrees?.removed?.length) {
    pending.rebuild = true
  }
  for (const tree of change.paneTrees?.set ?? []) {
    const shown = before.tabs.find((tab) => tab.id === tree.tabId)
    if (!shown?.terminal || unboundPaneTreeJson(shown.terminal) !== unboundPaneTreeJson(tree)) {
      pending.rebuild = true
    } else if (!pending.titled.has(shown.entityId)) {
      pending.titled.set(shown.entityId, shown)
    }
  }
  for (const leafId of [
    ...(change.bindings?.set ?? []).map((binding) => binding.leafId),
    ...(change.bindings?.removed ?? [])
  ]) {
    const tab = tabOwningLeaf([after, before], leafId)
    if (tab) {
      pending.rebound.add(tab.entityId)
    } else {
      pending.rebuild = true
    }
  }
}

/**
 * Adds a records frame's changes, each against the cache's copy `before` it applied to. A
 * workspace new to the stream, sent whole or gone leaves `shown`: only a full build shows it.
 */
export function notePendingRecordsFrame(
  pending: Map<string, PendingWorkspaceChanges>,
  shown: Set<string>,
  before: WorkspaceLayoutCache,
  after: WorkspaceLayoutCache,
  frame: WorkspaceLayoutRecordsFrame
): void {
  for (const change of frame.workspaces) {
    const shownLayout = before[change.key]
    const next = after[change.key]
    if (change.change !== 'records' || !shownLayout || !next) {
      shown.delete(change.key)
    } else {
      notePendingRecordChange(
        pendingWorkspaceChanges(pending, change.key),
        shownLayout,
        next,
        change
      )
    }
  }
}
