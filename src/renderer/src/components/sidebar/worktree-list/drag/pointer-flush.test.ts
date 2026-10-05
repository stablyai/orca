// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useWorktreeDragRuntime } from './use-runtime'
import { useWorktreePointerDragWindowEvents } from './use-pointer-window-events'
import { commitWorktreePointerDrop } from './pointer-commit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushWorktreePointerDragFrame, type WorktreePointerDragFrameArgs } from './pointer-flush'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET, WORKTREE_ROW_DRAG_INITIAL_STATE } from './row-state'

const workspaceBoardMocks = vi.hoisted(() => ({
  hasBoard: vi.fn(() => true)
}))

vi.mock('../../workspace-kanban-sidebar-drop', () => ({
  clearWorkspaceKanbanSidebarDropTargetVisual: vi.fn(),
  hasWorkspaceKanbanSidebarDropBoard: workspaceBoardMocks.hasBoard,
  isWorkspaceKanbanSidebarDropPointInBoard: () => false,
  updateWorkspaceKanbanSidebarDropTargetVisual: () => ({ status: null, isPinDrop: false })
}))

vi.mock('./pointer-commit', () => ({ commitWorktreePointerDrop: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  workspaceBoardMocks.hasBoard.mockReset()
  workspaceBoardMocks.hasBoard.mockReturnValue(true)
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
      draggedIds: ['child'],
      reorderDraggedIds: ['child'],
      reorderUnitDraggedIds: ['child'],
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
    preferSidebarStatusDropTargetsOnDrag: false,
    onWorkspaceBoardDragPreviewStart: vi.fn(),
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    shouldShowWorkspaceBoardDropIndicator: () => false,
    setDragOverStatus: vi.fn(),
    setDragOverStatusGroupKey: vi.fn(),
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
    status: (status: string | null, groupKey?: string) => {
      target = { ...NO_WORKTREE_SIDEBAR_DROP_TARGET, status, groupKey }
    },
    tick: (ms: number) => {
      time += ms
      const callback = nextFrame
      nextFrame = null
      callback?.(time)
    }
  }
}

describe('combined nesting and animated reordering', () => {
  it('lets the pointer cross an edge into nesting without moving the destination', () => {
    const t = setup()
    flushWorktreePointerDragFrame(t.args)
    expect(t.state().previewOffsetsByWorktreeId.size).toBe(0)
    t.nest('parent')
    t.tick(80)
    expect(t.state().lineageDropTargetId).toBe('parent')
    expect(t.state().previewOffsetsByWorktreeId.size).toBe(0)
    t.tick(200)
    expect(t.state().lineageDropTargetId).toBe('parent')
    expect(t.state().dropIndicatorY).toBeNull()
  })

  it('opens the reorder gap, holds it during nesting, then restores the edge preview', () => {
    const t = setup()
    flushWorktreePointerDragFrame(t.args)
    t.tick(160)
    expect(t.state().previewOffsetsByWorktreeId).toBe(t.offsets)
    expect(t.state().dropIndicatorY).toBe(300)
    t.nest('parent')
    flushWorktreePointerDragFrame(t.args)
    expect(t.state().lineageDropTargetId).toBe('parent')
    expect(t.state().previewOffsetsByWorktreeId).toBe(t.offsets)
    expect(t.state().dropIndicatorY).toBeNull()
    t.nest(null)
    flushWorktreePointerDragFrame(t.args)
    t.tick(160)
    expect(t.state().lineageDropTargetId).toBeNull()
    expect(t.state().previewOffsetsByWorktreeId).toBe(t.offsets)
    expect(t.state().dropIndicatorY).toBe(300)
  })

  it('clears the old line during a new intent and stops scheduling after settling', () => {
    const t = setup()
    flushWorktreePointerDragFrame(t.args)
    t.tick(160)
    expect(t.state().dropIndicatorY).toBe(300)
    t.args.drag.currentY = 356
    t.args.ctx.computeWorktreeDrop = () => ({
      dropIndex: 2,
      dropIndicatorY: 356,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: t.offsets
    })
    flushWorktreePointerDragFrame(t.args)
    expect(t.state().dropIndicatorY).toBeNull()
    expect(t.state().previewOffsetsByWorktreeId).toBe(t.offsets)
    t.tick(160)
    expect(t.state().dropIndicatorY).toBe(356)
    const frames = vi.mocked(window.requestAnimationFrame).mock.calls.length
    t.tick(1000)
    expect(vi.mocked(window.requestAnimationFrame).mock.calls).toHaveLength(frames)
  })
})

describe('nested Status targeting', () => {
  it('keeps drag targets in the sidebar instead of opening the full board', () => {
    workspaceBoardMocks.hasBoard.mockReturnValue(false)
    const t = setup()
    t.args.preferSidebarStatusDropTargetsOnDrag = true

    flushWorktreePointerDragFrame(t.args)

    expect(t.args.onWorkspaceBoardDragPreviewStart).not.toHaveBeenCalled()
    expect(t.args.drag.workspaceBoardDragPreviewRequested).toBe(false)
  })

  it('prefers an adjacent secondary Status lane over reordering in the source lane', () => {
    const t = setup()
    t.args.drag.sourceGroupKey = 'repo:git:git.example.com/org/orca/workspace-status:todo'
    t.args.ctx.workspaceStatuses = [
      { id: 'todo', label: 'To do' },
      { id: 'in-progress', label: 'In progress' }
    ]
    t.args.ctx.scrollRef.current = document.createElement('div')
    t.status('in-progress', 'repo:git:git.example.com/org/orca/workspace-status:in-progress')
    const statusDrop = {
      dropIndex: 0,
      dropIndicatorY: 240,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: new Map<string, number>()
    }
    const computeStatusDrop = vi.fn(() => statusDrop)
    const computeSourceDrop = vi.fn(t.args.ctx.computeWorktreeDrop)
    t.args.ctx.computeWorktreeStatusDrop = computeStatusDrop
    t.args.ctx.computeWorktreeDrop = computeSourceDrop

    flushWorktreePointerDragFrame(t.args)

    expect(computeStatusDrop).toHaveBeenCalledWith({
      pointerY: 300,
      status: 'in-progress',
      groupKey: 'repo:git:git.example.com/org/orca/workspace-status:in-progress',
      draggedIds: ['child']
    })
    expect(computeSourceDrop).not.toHaveBeenCalled()
    expect(t.state()).toMatchObject({
      sourceGroupKey: null,
      dropIndex: 0,
      dropIndicatorY: 240
    })
    expect(t.args.drag.latestStatusDropTarget?.target).toMatchObject({
      status: 'in-progress',
      groupKey: 'repo:git:git.example.com/org/orca/workspace-status:in-progress'
    })
  })

  it('uses the nested Status lane under the pointer for a Pinned source', () => {
    const t = setup()
    t.args.drag.sourceGroupKey = 'pinned'
    t.args.ctx.scrollRef.current = document.createElement('div')
    const targetGroupKey = 'repo:repo-1/workspace-status:completed'
    t.status('completed', targetGroupKey)
    const computeStatusDrop = vi.fn(() => ({
      dropIndex: 0,
      dropIndicatorY: 240,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: new Map<string, number>()
    }))
    const computeSourceDrop = vi.fn(t.args.ctx.computeWorktreeDrop)
    t.args.ctx.computeWorktreeStatusDrop = computeStatusDrop
    t.args.ctx.computeWorktreeDrop = computeSourceDrop

    flushWorktreePointerDragFrame(t.args)

    expect(computeStatusDrop).toHaveBeenCalledWith({
      pointerY: 300,
      status: 'completed',
      groupKey: targetGroupKey,
      draggedIds: ['child']
    })
    expect(computeSourceDrop).not.toHaveBeenCalled()
  })

  it('carries every selected worktree into a nested Status drop', () => {
    const t = setup()
    t.args.drag.sourceGroupKey = 'repo:repo-1/workspace-status:todo'
    t.args.drag.draggedIds = ['child', 'selected-sibling']
    t.args.drag.reorderDraggedIds = ['child', 'selected-sibling']
    t.args.ctx.workspaceStatuses = [
      { id: 'todo', label: 'To do' },
      { id: 'in-progress', label: 'In progress' }
    ]
    t.args.ctx.scrollRef.current = document.createElement('div')
    t.status('in-progress', 'repo:repo-1/workspace-status:in-progress')
    const computeStatusDrop = vi.fn(() => ({
      dropIndex: 0,
      dropIndicatorY: 240,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: new Map<string, number>()
    }))
    t.args.ctx.computeWorktreeStatusDrop = computeStatusDrop

    flushWorktreePointerDragFrame(t.args)

    expect(computeStatusDrop).toHaveBeenCalledWith({
      pointerY: 300,
      status: 'in-progress',
      groupKey: 'repo:repo-1/workspace-status:in-progress',
      draggedIds: ['child', 'selected-sibling']
    })
    expect(t.args.drag.latestStatusDropTarget?.target).toMatchObject({
      status: 'in-progress',
      groupKey: 'repo:repo-1/workspace-status:in-progress'
    })
  })

  it('scopes an empty-lane hover to the exact nested Status header', () => {
    const t = setup()
    const targetGroupKey = 'repo:repo-1/workspace-status:completed'
    t.args.drag.sourceGroupKey = 'repo:repo-1/workspace-status:todo'
    t.args.ctx.workspaceStatuses = [
      { id: 'todo', label: 'To do' },
      { id: 'completed', label: 'Done' }
    ]
    t.args.ctx.scrollRef.current = document.createElement('div')
    t.status('completed', targetGroupKey)

    flushWorktreePointerDragFrame(t.args)

    expect(t.args.setDragOverStatus).toHaveBeenLastCalledWith('completed')
    expect(t.args.setDragOverStatusGroupKey).toHaveBeenLastCalledWith(targetGroupKey)
    expect(t.state().dropIndicatorY).toBeNull()
  })
})

describe('stationary pointer autoscroll', () => {
  it.each([1, -1])('keeps the gap tracking slots while scrolling in direction %s', (direction) => {
    const t = setup()
    const container = document.createElement('div')
    t.args.ctx.scrollRef.current = container
    let index = 10
    let offsets = new Map([['parent', 56]])
    t.args.ctx.computeWorktreeDrop = () => ({
      dropIndex: index,
      dropIndicatorY: 300 - container.scrollTop,
      dropAnchorId: null,
      previewOffsetsByWorktreeId: offsets
    })
    flushWorktreePointerDragFrame(t.args)
    for (let frame = 1; frame <= 6; frame++) {
      index += direction
      container.scrollTop += direction * 56
      offsets = new Map([[`row-${index}`, direction * 56]])
      t.tick(80)
      flushWorktreePointerDragFrame(t.args)
      if (frame >= 2) {
        expect(t.state().previewOffsetsByWorktreeId).toBe(offsets)
        expect(t.state().dropIndicatorY).toBe(300 - container.scrollTop)
      }
    }
    expect(t.args.drag.currentY).toBe(300)
  })
})

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

  it('leaves other keys and Escape without a drag available to the app', () => {
    const t = renderDrag()
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    window.dispatchEvent(enter)
    expect(enter.defaultPrevented).toBe(false)
    expect(t.result.current.worktreePointerDragRef.current).toBe(t.args.drag)
    act(() => t.result.current.clearWorktreeDrag())
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(escape)
    expect(escape.defaultPrevented).toBe(false)
    expect(t.cancelBoard).toHaveBeenCalledOnce()
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
