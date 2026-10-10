// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitWorktreePointerDrop } from './pointer-commit'
import { flushWorktreePointerDragFrame, type WorktreePointerDragFrameArgs } from './pointer-flush'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET, WORKTREE_ROW_DRAG_INITIAL_STATE } from './row-state'

vi.mock('../../workspace-kanban-sidebar-drop', () => ({
  clearWorkspaceKanbanSidebarDropTargetVisual: vi.fn(),
  getWorkspaceKanbanSidebarDropGroups: () => [],
  getWorkspaceKanbanSidebarDropTarget: () => null,
  hasWorkspaceKanbanSidebarDropBoard: () => false,
  isWorkspaceKanbanSidebarDropPointInBoard: () => false,
  resolveWorkspaceKanbanSidebarFullLaneDropIndex: () => 0,
  updateWorkspaceKanbanSidebarDropTargetVisual: () => ({ status: 'done', isPinDrop: false })
}))

afterEach(() => {
  vi.restoreAllMocks()
})

const FOLDER_GROUP = {
  key: 'folder-workspaces:project-group:group-a:group-a',
  worktreeIds: ['folder:a', 'folder:b', 'folder:c']
}

function setup(drop: { dropIndex: number } | null) {
  let time = 0
  let nextFrame: FrameRequestCallback | null = null
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    nextFrame = callback
    return 1
  })
  let state = WORKTREE_ROW_DRAG_INITIAL_STATE
  const args: WorktreePointerDragFrameArgs = {
    drag: {
      pointerId: 1,
      sourceRow: document.createElement('div'),
      startX: 100,
      startY: 400,
      currentX: 100,
      currentY: 300,
      worktreeId: 'folder:c',
      draggedIds: ['folder:c'],
      reorderDraggedIds: ['folder:c'],
      reorderUnitDraggedIds: ['folder:c'],
      sourceGroupKey: FOLDER_GROUP.key,
      rects: [],
      active: true,
      preview: document.createElement('div'),
      previewOffsetX: 20,
      previewOffsetY: 20,
      workspaceBoardDragPreviewRequested: false,
      frameId: null,
      reorderIntent: null,
      latestBoardDropTarget: null,
      latestStatusDropTarget: null
    },
    ctx: {
      scrollRef: { current: document.createElement('div') },
      workspaceStatuses: [],
      worktreeDragGroups: [],
      worktreeDragUnitGroups: [],
      folderWorkspaceDragGroups: [FOLDER_GROUP],
      refreshWorktreeDragSession: () => true,
      // A worktree under the pointer would offer nesting; folder drags must ignore it.
      getEligibleLineageDropTarget: () => ({
        ...NO_WORKTREE_SIDEBAR_DROP_TARGET,
        lineageParentId: 'worktree-parent'
      }),
      computeWorktreeDrop: () =>
        drop
          ? {
              ...drop,
              dropIndicatorY: 300,
              dropAnchorId: 'folder:a',
              previewOffsetsByWorktreeId: new Map([['folder:a', 56]])
            }
          : null,
      computeWorktreeStatusDrop: () => null,
      commitWorktreeLineageParentDrop: vi.fn(() => true),
      clearReorderedWorktreeParents: vi.fn(),
      clearWorktreeDrag: vi.fn(),
      onMoveWorktreesToStatus: vi.fn(),
      onMoveWorktreesToStatusAtIndex: vi.fn(),
      onReorderWorktrees: vi.fn(),
      onPinWorktrees: vi.fn()
    },
    workspaceBoardOpen: false,
    onWorkspaceBoardDragPreviewStart: vi.fn(),
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    shouldShowWorkspaceBoardDropIndicator: () => true,
    setDragOverStatus: vi.fn(),
    setPinDragOver: vi.fn(),
    setWorktreeDragState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    }
  }
  return {
    args,
    state: () => state,
    tick: (ms: number) => {
      time += ms
      const callback = nextFrame
      nextFrame = null
      callback?.(time)
    }
  }
}

function commit(args: WorktreePointerDragFrameArgs, onDropWorktreesOnWorkspaceBoard = vi.fn()) {
  commitWorktreePointerDrop({
    event: new PointerEvent('pointerup', { clientX: 100, clientY: 300 }),
    drag: args.drag,
    ctx: args.ctx,
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    onDropWorktreesOnWorkspaceBoard
  })
}

describe('folder workspace pointer drag', () => {
  it('shows only a reorder slot, never the board, nesting, or status targets', () => {
    const t = setup({ dropIndex: 0 })
    flushWorktreePointerDragFrame(t.args)
    t.tick(200)

    expect(t.args.onWorkspaceBoardDragPreviewStart).not.toHaveBeenCalled()
    expect(t.state().lineageDropTargetId).toBeNull()
    expect(t.state().dropIndex).toBe(0)
    expect(t.state().previewOffsetsByWorktreeId.get('folder:a')).toBe(56)
  })

  it('reorders within its own run using only that run as the visible order', () => {
    const t = setup({ dropIndex: 0 })
    const onDropWorktreesOnWorkspaceBoard = vi.fn()
    commit(t.args, onDropWorktreesOnWorkspaceBoard)

    expect(t.args.ctx.onReorderWorktrees).toHaveBeenCalledWith({
      groups: [FOLDER_GROUP],
      sourceGroupKey: FOLDER_GROUP.key,
      draggedIds: ['folder:c'],
      dropIndex: 0
    })
    expect(onDropWorktreesOnWorkspaceBoard).not.toHaveBeenCalled()
    expect(t.args.ctx.commitWorktreeLineageParentDrop).not.toHaveBeenCalled()
    expect(t.args.ctx.onPinWorktrees).not.toHaveBeenCalled()
    expect(t.args.ctx.clearWorktreeDrag).toHaveBeenCalled()
  })

  it('drops outside its run as a no-op', () => {
    const t = setup(null)
    commit(t.args)

    expect(t.args.ctx.onReorderWorktrees).not.toHaveBeenCalled()
    expect(t.args.ctx.onMoveWorktreesToStatus).not.toHaveBeenCalled()
    expect(t.args.ctx.onMoveWorktreesToStatusAtIndex).not.toHaveBeenCalled()
    expect(t.args.ctx.commitWorktreeLineageParentDrop).not.toHaveBeenCalled()
    expect(t.args.ctx.clearWorktreeDrag).toHaveBeenCalled()
  })
})
