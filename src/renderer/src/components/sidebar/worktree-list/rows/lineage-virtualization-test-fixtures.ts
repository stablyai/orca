import { vi } from 'vitest'
import { makeWorktree } from '../../worktree-list-lineage-card-test-fixtures'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from '../drag/row-state'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import type { LineageDescendantContext } from './VirtualizedLineageDescendants'

export function lineageRow(id: string, depth = 1): WorktreeItemRow {
  return {
    type: 'item',
    rowKey: `all:|${id}`,
    sectionKey: 'all',
    worktree: makeWorktree({ id, displayName: id, branch: id, sortOrder: 0, instanceId: id }),
    repo: undefined,
    depth,
    groupDepth: 0,
    lineageTrail: [],
    isLastLineageChild: false,
    lineageChildCount: 0
  }
}

export function lineageContext(): LineageDescendantContext {
  const onImmediateActivate = vi.fn()
  return {
    scrollRef: { current: null },
    lineageMeasuredHeights: new Map(),
    shouldAdjustLineageScroll: () => false,
    pendingRevealWorktree: null,
    pendingRevealSidebarRow: null,
    worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
    activeWorktreeId: 'root',
    item: {
      settings: null,
      groupBy: 'none',
      folderBackedProjectGroupIds: new Set(),
      groupKeyByRowKey: new Map(),
      groupIndexByRowKey: new Map(),
      agentSendTargetWorktreeId: null,
      worktreeDragState: WORKTREE_ROW_DRAG_INITIAL_STATE,
      nativeLineageDropTargetId: null,
      activeWorktreeId: 'root',
      activeWorkspaceExecutionHostId: 'local',
      currentWorktreeId: 'root',
      highlightedRevealRowKey: null,
      selectedWorktreeIds: new Set(),
      selectedWorktrees: [],
      getActiveSurfaceVariant: () => 'primary',
      getLineageToggleHandler: () => vi.fn(),
      onSelectionGesture: () => false,
      onContextMenuSelect: () => [],
      onImmediateActivate,
      onRowClickCapture: vi.fn(),
      onRowPointerDown: vi.fn(),
      onCardDragStart: vi.fn(),
      onCardDragEnd: vi.fn()
    }
  }
}
