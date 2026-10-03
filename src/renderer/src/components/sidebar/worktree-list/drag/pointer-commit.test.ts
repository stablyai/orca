// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitWorktreePointerDrop } from './pointer-commit'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { WorktreePointerDrag } from './row-state'

vi.mock('../../workspace-kanban-sidebar-drop', () => ({
  getWorkspaceKanbanSidebarDropGroups: () => [],
  getWorkspaceKanbanSidebarDropTarget: () => ({ status: null, isPinDrop: false }),
  isWorkspaceKanbanSidebarDropPointInBoard: () => false,
  resolveWorkspaceKanbanSidebarFullLaneDropIndex: (_status: string, dropIndex: number) => dropIndex
}))

vi.mock('../../workspace-kanban-card-pointer-drag-dom', () => ({
  resolveWorkspaceKanbanCardDropCommitTarget: () => ({ status: null, isPinDrop: false })
}))

afterEach(() => {
  vi.restoreAllMocks()
})

describe('commitWorktreePointerDrop', () => {
  it('commits the index against the exact nested Status lane under the pointer', () => {
    const sourceGroupKey = 'repo:repo-a/workspace-status:todo'
    const targetGroupKey = 'repo:repo-b/workspace-status:in-progress'
    const container = document.createElement('div')
    const target = document.createElement('div')
    target.dataset.workspaceStatusDropTarget = ''
    target.dataset.workspaceStatus = 'in-progress'
    target.dataset.workspaceStatusGroupKey = targetGroupKey
    container.append(target)
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    const computeWorktreeStatusDrop = vi.fn(() => ({
      dropIndex: 2,
      dropIndicatorY: 100,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: new Map<string, number>()
    }))
    const onMoveWorktreesToStatusAtIndex = vi.fn()
    const ctx = {
      scrollRef: { current: container },
      workspaceStatuses: [
        { id: 'todo', label: 'To do' },
        { id: 'in-progress', label: 'In progress' }
      ],
      worktreeDragGroups: [],
      worktreeDragUnitGroups: [],
      computeWorktreeDrop: vi.fn(() => null),
      computeWorktreeStatusDrop,
      refreshWorktreeDragSession: () => true,
      getEligibleLineageDropTarget: (dropTarget) => dropTarget,
      commitWorktreeLineageParentDrop: vi.fn(() => false),
      clearReorderedWorktreeParents: vi.fn(),
      clearWorktreeDrag: vi.fn(),
      onMoveWorktreesToStatus: vi.fn(),
      onMoveWorktreesToStatusAtIndex,
      onReorderWorktrees: vi.fn(),
      onPinWorktrees: vi.fn()
    } satisfies WorktreeDropCommitContext
    const drag: WorktreePointerDrag = {
      pointerId: 1,
      sourceRow: document.createElement('div'),
      startX: 10,
      startY: 20,
      currentX: 10,
      currentY: 20,
      worktreeId: 'wt-1',
      draggedIds: ['wt-1'],
      reorderDraggedIds: ['wt-1'],
      reorderUnitDraggedIds: ['wt-1'],
      sourceGroupKey,
      rects: [],
      active: true,
      preview: null,
      previewOffsetX: 0,
      previewOffsetY: 0,
      workspaceBoardDragPreviewRequested: false,
      frameId: null,
      reorderIntent: null,
      latestBoardDropTarget: null,
      latestStatusDropTarget: null
    }

    commitWorktreePointerDrop({
      event: new PointerEvent('pointerup', { clientX: 10, clientY: 20 }),
      drag,
      ctx,
      onWorkspaceBoardDragPreviewCommit: vi.fn(),
      onDropWorktreesOnWorkspaceBoard: vi.fn()
    })

    expect(computeWorktreeStatusDrop).toHaveBeenCalledExactlyOnceWith({
      pointerY: 20,
      status: 'in-progress',
      groupKey: targetGroupKey,
      draggedIds: ['wt-1']
    })
    expect(onMoveWorktreesToStatusAtIndex).toHaveBeenCalledExactlyOnceWith({
      worktreeIds: ['wt-1'],
      status: 'in-progress',
      targetGroupKey,
      dropIndex: 2,
      groups: []
    })
  })
})
