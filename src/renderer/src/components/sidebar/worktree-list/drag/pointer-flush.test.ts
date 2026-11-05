// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useWorktreeDragRuntime } from './use-runtime'
import { useWorktreePointerDragWindowEvents } from './use-pointer-window-events'
import { commitWorktreePointerDrop } from './pointer-commit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorktreePointerDragFrameArgs } from './pointer-flush'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET, WORKTREE_ROW_DRAG_INITIAL_STATE } from './row-state'

vi.mock('../../workspace-board/drag/workspace-kanban-sidebar-drop', () => ({
  clearWorkspaceKanbanSidebarDropTargetVisual: vi.fn(),
  hasWorkspaceKanbanSidebarDropBoard: () => true,
  isWorkspaceKanbanSidebarDropPointInBoard: () => false,
  updateWorkspaceKanbanSidebarDropTargetVisual: () => ({ status: null, isPinDrop: false })
}))

vi.mock('./pointer-commit', () => ({ commitWorktreePointerDrop: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function setup() {
  let time = 0
  let nextFrame: FrameRequestCallback | null = null
  vi.spyOn(performance, 'now').mockImplementation(() => time)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    nextFrame = callback
    return 1
  })
  let state = WORKTREE_ROW_DRAG_INITIAL_STATE
  let target = NO_WORKTREE_SIDEBAR_DROP_TARGET
  const offsets = new Map([['parent', 56]])
  const args: WorktreePointerDragFrameArgs = {
    drag: {
      pointerId: 1,
      sourceRow: document.createElement('div'),
      startX: 100,
      startY: 400,
      currentX: 100,
      currentY: 300,
      worktreeId: 'child',
      worktreeKey: 'child',
      draggedIds: ['child'],
      draggedCopies: [],
      reorderDraggedIds: ['child'],
      reorderDraggedKeys: ['child'],
      reorderUnitDraggedKeys: ['child'],
      sourceGroupKey: 'repo',
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
      scrollRef: { current: null },
      workspaceStatuses: [],
      worktreeDragGroups: [],
      worktreeDragUnitGroups: [],
      refreshWorktreeDragSession: () => true,
      getEligibleLineageDropTarget: () => target,
      computeWorktreeDrop: () => ({
        dropIndex: 1,
        dropIndicatorY: 300,
        dropAnchorId: 'parent',
        previewOffsetsByWorktreeId: offsets
      }),
      computeWorktreeStatusDrop: () => null,
      commitWorktreeLineageParentDrop: () => true,
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
    shouldShowWorkspaceBoardDropIndicator: () => false,
    setDragOverStatus: vi.fn(),
    setPinDragOver: vi.fn(),
    setWorktreeDragState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    }
  }
  return {
    args,
    offsets,
    state: () => state,
    nest: (id: string | null) => {
      target = { ...NO_WORKTREE_SIDEBAR_DROP_TARGET, lineageParentId: id }
    },
    tick: (ms: number) => {
      time += ms
      const callback = nextFrame
      nextFrame = null
      callback?.(time)
    }
  }
}

describe('Escape during pointer dragging', () => {
  function renderDrag() {
    const t = setup()
    const cancelBoard = vi.fn()
    const { result, unmount } = renderHook(() => {
      const runtime = useWorktreeDragRuntime({
        worktreeDragSessionRef: { current: null },
        statusDropAnchorsRef: { current: new Map() },
        onWorkspaceBoardDragPreviewCancel: cancelBoard
      })
      useWorktreePointerDragWindowEvents({
        ctx: t.args.ctx,
        runtime,
        beginWorktreePointerDrag: vi.fn(),
        scheduleWorktreePointerDragFrame: vi.fn(),
        onWorkspaceBoardDragPreviewCommit: vi.fn(),
        onDropWorktreesOnWorkspaceBoard: vi.fn()
      })
      return runtime
    })
    result.current.worktreePointerDragRef.current = t.args.drag
    if (t.args.drag.preview) {
      document.body.append(t.args.drag.preview)
    }
    return { ...t, result, unmount, cancelBoard }
  }

  it('removes the preview and cancels frames without committing on pointer release', () => {
    const t = renderDrag()
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame')
    t.args.drag.frameId = 12
    t.result.current.pointerAutoscrollFrameIdRef.current = 13
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    act(() => window.dispatchEvent(escape))
    expect(escape.defaultPrevented).toBe(true)
    expect(t.result.current.worktreePointerDragRef.current).toBeNull()
    expect(t.args.drag.preview?.isConnected).toBe(false)
    expect(cancelFrame).toHaveBeenCalledWith(12)
    expect(cancelFrame).toHaveBeenCalledWith(13)
    expect(t.cancelBoard).toHaveBeenCalledOnce()
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    expect(commitWorktreePointerDrop).not.toHaveBeenCalled()
    expect(t.result.current.worktreeDragState).toBe(WORKTREE_ROW_DRAG_INITIAL_STATE)
  })

  it('removes its Escape listener on unmount', () => {
    const t = renderDrag()
    t.unmount()
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(t.cancelBoard).not.toHaveBeenCalled()
    t.args.drag.preview?.remove()
  })
})
