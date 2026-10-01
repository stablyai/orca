// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commitWorktreePointerDrop } from './pointer-commit'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import type { WorktreePointerDrag } from './row-state'
import { NO_WORKTREE_SIDEBAR_DROP_TARGET } from './row-state'
import { getTagGroupKey } from '../grouping/tag-groups'
import { getTagDropTargetProps } from './tag-target'

vi.mock('../../workspace-kanban-sidebar-drop', () => ({
  getWorkspaceKanbanSidebarDropGroups: () => [],
  getWorkspaceKanbanSidebarDropTarget: () => null,
  isWorkspaceKanbanSidebarDropPointInBoard: () => false,
  resolveWorkspaceKanbanSidebarFullLaneDropIndex: () => 0
}))
vi.mock('../../workspace-kanban-card-pointer-drag-dom', () => ({
  resolveWorkspaceKanbanCardDropCommitTarget: () => ({ status: null, isPinDrop: false })
}))

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

function renderSection(sectionKey: string): HTMLElement {
  const container = document.createElement('div')
  const row = document.createElement('div')
  for (const [name, value] of Object.entries(getTagDropTargetProps(sectionKey))) {
    row.setAttribute(name, value)
  }
  const card = document.createElement('span')
  row.append(card)
  container.append(row)
  document.body.append(container)
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(card)
  return container
}

function commit(container: HTMLElement, sourceGroupKey: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a tag drop returns before reading any other context member.
  const ctx = {
    scrollRef: { current: container },
    refreshWorktreeDragSession: () => true,
    getEligibleLineageDropTarget: () => NO_WORKTREE_SIDEBAR_DROP_TARGET,
    computeWorktreeDrop: vi.fn(() => null),
    onReorderWorktrees: vi.fn(),
    onTagWorktrees: vi.fn(),
    clearWorktreeDrag: vi.fn()
  } as unknown as WorktreeDropCommitContext
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reads only these drag fields on the tag path.
  const drag = {
    draggedIds: ['wt-1', 'wt-2'],
    draggedIdentities: ['local::wt-1', 'local::wt-2'],
    reorderDraggedIds: ['wt-1', 'wt-2'],
    sourceGroupKey,
    latestBoardDropTarget: null,
    latestStatusDropTarget: null
  } as unknown as WorktreePointerDrag
  commitWorktreePointerDrop({
    event: new PointerEvent('pointerup', { clientX: 10, clientY: 10 }),
    drag,
    ctx,
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    onDropWorktreesOnWorkspaceBoard: vi.fn()
  })
  return ctx
}

describe('pointer drop onto a tag section', () => {
  it('adds that tag when dropped into a different tag section', () => {
    const ctx = commit(renderSection(getTagGroupKey('billing team')), getTagGroupKey('api'))

    expect(ctx.onTagWorktrees).toHaveBeenCalledWith(['local::wt-1', 'local::wt-2'], 'billing team')
    expect(ctx.clearWorktreeDrag).toHaveBeenCalled()
  })

  it('keeps reorder behavior inside the section the drag started in', () => {
    const section = getTagGroupKey('billing team')
    const ctx = commit(renderSection(section), section)

    expect(ctx.onTagWorktrees).not.toHaveBeenCalled()
    expect(ctx.computeWorktreeDrop).toHaveBeenCalled()
  })

  it('treats Untagged as no tag target', () => {
    expect(getTagDropTargetProps('tag-untagged')).toEqual({})
  })
})
