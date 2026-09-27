import { vi } from 'vitest'
import { makeWorktree } from '../../worktree-list-lineage-card-test-fixtures'
import { WORKTREE_ROW_DRAG_INITIAL_STATE } from '../drag/row-state'
import type { RenderRow } from '../listing/render-row'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import type { LineageDescendantContext } from './VirtualizedLineageDescendants'
import type { VirtualizedWorktreeViewportProps } from '../viewport/viewport-props'
import { buildSidebarGeometry } from '../listing/sidebar-geometry-slots'

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

export function lineageContext(): LineageDescendantContext &
  Pick<
    VirtualizedWorktreeViewportProps,
    'pendingRevealWorktree' | 'pendingRevealSidebarRow' | 'activeWorktreeId'
  > {
  const onImmediateActivate = vi.fn()
  return {
    geometry: { model: buildSidebarGeometry([]), boundaries: [0], selected: new Set() },
    pendingRevealWorktree: null,
    pendingRevealSidebarRow: null,
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

export function geometryFolderRow(
  groupDepth = 1
): Extract<RenderRow, { type: 'folder-workspace' }> {
  return {
    type: 'folder-workspace',
    key: 'folder-workspace:folder',
    depth: 0,
    groupDepth,
    folderWorkspace: {
      id: 'folder',
      projectGroupId: 'group',
      name: 'Folder',
      folderPath: '/tmp/folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    },
    projectGroup: {
      id: 'group',
      name: 'Group',
      parentPath: '/tmp',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
  }
}
