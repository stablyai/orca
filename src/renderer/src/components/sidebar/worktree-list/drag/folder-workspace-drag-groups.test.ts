// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { buildRows } from '../grouping/build-rows'
import type { Row, WorktreeGroupBy } from '../grouping/row-types'
import { getWorktreeDragGroups, getWorktreeDragIndexes } from './groups'
import { flushWorktreePointerDragFrame } from './pointer-flush'
import { commitWorktreePointerDrop } from './pointer-commit'
import {
  NO_WORKTREE_SIDEBAR_DROP_TARGET,
  WORKTREE_ROW_DRAG_INITIAL_STATE,
  type WorktreePointerDrag
} from './row-state'
import type { WorktreeDropCommitContext } from './drop-commit-context'
import { createTestStore } from '../../../../store/slices/store-test-helpers'
import { makeFolderWorkspace } from '../../../../store/slices/worktrees-slice-test-fixtures'
import { getWorktreeDragUnitGroups } from '../../worktree-drag-units'
import {
  buildManualOrderUpdatesForVisibleGroups,
  type WorktreeManualOrderUpdate
} from '../../worktree-manual-order'
import { buildWorktreeManualOrderCatalog } from '../../worktree-manual-order-catalog'
import { repo, worktree } from '../../worktree-list-groups-test-fixtures'
import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { FolderWorkspace } from '../../../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'

const GROUP: ProjectGroup = {
  id: 'group-1',
  name: 'Agent conversations',
  parentPath: '/tmp/conversations',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const GROUPED_REPO: Repo = { ...repo, projectGroupId: GROUP.id }
const WORKTREE: Worktree = { ...worktree, manualOrder: 500 }

const folder = (id: string, manualOrder: number): FolderWorkspace =>
  makeFolderWorkspace({ id, projectGroupId: GROUP.id, manualOrder, workspaceStatus: 'in-progress' })
// Highest manualOrder renders first, so the sidebar shows a, b, c.
const FOLDERS = [folder('fw-a', 3000), folder('fw-b', 2000), folder('fw-c', 1000)]
const FOLDER_A = folderWorkspaceKey('fw-a')
const FOLDER_B = folderWorkspaceKey('fw-b')
const FOLDER_C = folderWorkspaceKey('fw-c')

function buildSidebarRows(
  groupBy: WorktreeGroupBy,
  folderWorkspaces: readonly FolderWorkspace[] = FOLDERS,
  worktrees: Worktree[] = [WORKTREE]
): Row[] {
  return buildRows(
    groupBy,
    worktrees,
    new Map([[GROUPED_REPO.id, GROUPED_REPO]]),
    null,
    new Set<string>(),
    undefined,
    undefined,
    'manual',
    {},
    undefined,
    false,
    undefined,
    [GROUP],
    new Set(),
    new Map(),
    new Map(),
    [],
    undefined,
    folderWorkspaces
  )
}

function renderedFolderIds(rows: readonly Row[]): string[] {
  return rows.flatMap((row) =>
    row.type === 'folder-workspace' ? [folderWorkspaceKey(row.folderWorkspace.id)] : []
  )
}

// The drag group a row moves in, or '' when it has none.
function dragGroupKey(rows: Row[], worktreeId: string): string {
  const owner = getWorktreeDragGroups(rows).find((group) => group.worktreeIds.includes(worktreeId))
  return owner?.key ?? ''
}

const SLOT = {
  dropIndex: 0,
  dropIndicatorY: 300,
  dropAnchorId: null,
  previewOffsetsByWorktreeId: new Map<string, number>()
}
const LANE_TARGET = { status: 'in-review', isPinDrop: false, lineageParentId: null }
const PIN_TARGET = { status: null, isPinDrop: true, lineageParentId: null }

function statusLaneDragKeys(): { folderKey: string; worktreeKey: string } {
  const rows = buildSidebarRows('workspace-status')
  return { folderKey: dragGroupKey(rows, FOLDER_A), worktreeKey: dragGroupKey(rows, WORKTREE.id) }
}

function pointerDrag(
  sourceGroupKey: string,
  worktreeId: string,
  selection = [worktreeId]
): WorktreePointerDrag {
  return {
    pointerId: 1,
    sourceRow: document.createElement('div'),
    startX: 100,
    startY: 100,
    currentX: 100,
    currentY: 300,
    worktreeId,
    draggedIds: selection,
    reorderDraggedIds: selection,
    reorderUnitDraggedIds: [worktreeId],
    sourceGroupKey,
    rects: [],
    active: true,
    preview: document.createElement('div'),
    previewOffsetX: 0,
    previewOffsetY: 0,
    workspaceBoardDragPreviewRequested: false,
    frameId: null,
    reorderIntent: null,
    latestBoardDropTarget: null,
    latestStatusDropTarget: null
  }
}

// The pointer has left its own group and sits over another status lane that takes worktrees.
function dropContext(
  overrides: Partial<WorktreeDropCommitContext> = {}
): WorktreeDropCommitContext {
  return {
    scrollRef: { current: document.createElement('div') },
    workspaceStatuses: [],
    worktreeDragGroups: [],
    worktreeDragUnitGroups: [],
    computeWorktreeDrop: () => null,
    computeWorktreeStatusDrop: () => SLOT,
    refreshWorktreeDragSession: () => true,
    getEligibleLineageDropTarget: () => LANE_TARGET,
    commitWorktreeLineageParentDrop: () => true,
    clearReorderedWorktreeParents: vi.fn(),
    clearWorktreeDrag: vi.fn(),
    onMoveWorktreesToStatus: vi.fn(),
    onMoveWorktreesToStatusAtIndex: vi.fn(),
    onReorderWorktrees: vi.fn(),
    onPinWorktrees: vi.fn(),
    ...overrides
  }
}

function flushOver(sourceGroupKey: string, worktreeId: string) {
  let state = WORKTREE_ROW_DRAG_INITIAL_STATE
  const onWorkspaceBoardDragPreviewStart = vi.fn()
  flushWorktreePointerDragFrame({
    drag: pointerDrag(sourceGroupKey, worktreeId),
    ctx: dropContext(),
    workspaceBoardOpen: false,
    onWorkspaceBoardDragPreviewStart,
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    shouldShowWorkspaceBoardDropIndicator: () => true,
    setDragOverStatus: vi.fn(),
    setPinDragOver: vi.fn(),
    setWorktreeDragState: (update) => {
      state = typeof update === 'function' ? update(state) : update
    }
  })
  return { state, onWorkspaceBoardDragPreviewStart }
}

function releaseOver(
  sourceGroupKey: string,
  worktreeId: string,
  overrides: Partial<WorktreeDropCommitContext> = {},
  selection = [worktreeId]
): WorktreeDropCommitContext {
  const ctx = dropContext(overrides)
  commitWorktreePointerDrop({
    event: new PointerEvent('pointerup', { clientX: 100, clientY: 300 }),
    drag: pointerDrag(sourceGroupKey, worktreeId, selection),
    ctx,
    onWorkspaceBoardDragPreviewCommit: vi.fn(),
    onDropWorktreesOnWorkspaceBoard: vi.fn()
  })
  return ctx
}

// Drops the first selected row on a slot of its own group; returns the manual order it saves.
function saveSlotDrop(rows: Row[], worktrees: Worktree[], selection: string[], dropIndex: number) {
  const catalog = buildWorktreeManualOrderCatalog({ worktrees, folderWorkspaces: FOLDERS })
  const [draggedId = ''] = selection
  let saved = new Map<string, WorktreeManualOrderUpdate>()
  const overrides: Partial<WorktreeDropCommitContext> = {
    worktreeDragGroups: getWorktreeDragGroups(rows),
    worktreeDragUnitGroups: getWorktreeDragUnitGroups(rows),
    getEligibleLineageDropTarget: () => NO_WORKTREE_SIDEBAR_DROP_TARGET,
    computeWorktreeDrop: () => ({ ...SLOT, dropIndex }),
    onReorderWorktrees: (reorder) => {
      saved = buildManualOrderUpdatesForVisibleGroups({
        ...reorder,
        now: 10_000,
        rankByWorktreeId: catalog.rankByWorktreeId,
        allWorktreeIds: catalog.orderedIds
      }).updates
    }
  }
  releaseOver(dragGroupKey(rows, draggedId), draggedId, overrides, selection)
  return saved
}

describe('folder workspace sidebar drag groups', () => {
  it('makes the folder workspaces of a project group one drag group in rendered order', () => {
    const rows = buildSidebarRows('repo')
    expect(renderedFolderIds(rows)).toEqual([FOLDER_A, FOLDER_B, FOLDER_C])

    const folderGroup = getWorktreeDragGroups(rows).find((group) =>
      group.worktreeIds.includes(FOLDER_A)
    )
    expect(folderGroup?.worktreeIds).toEqual([FOLDER_A, FOLDER_B, FOLDER_C])
    const unitGroup = getWorktreeDragUnitGroups(rows).find(
      (group) => group.key === folderGroup?.key
    )
    expect(unitGroup?.worktreeIds).toEqual([FOLDER_A, FOLDER_B, FOLDER_C])

    // The pointer drag starts only for rows indexed here, keyed like the folder row's row key.
    const { groupKeyByRowKey, groupIndexByRowKey } = getWorktreeDragIndexes(rows)
    expect([FOLDER_A, FOLDER_B, FOLDER_C].map((id) => groupKeyByRowKey.get(id))).toEqual([
      folderGroup?.key,
      folderGroup?.key,
      folderGroup?.key
    ])
    expect([FOLDER_A, FOLDER_B, FOLDER_C].map((id) => groupIndexByRowKey.get(id))).toEqual([
      0, 1, 2
    ])
  })

  it('keeps a folder workspace where it was dropped above its siblings', () => {
    const saved = saveSlotDrop(buildSidebarRows('repo'), [WORKTREE], [FOLDER_C], 0)

    // The drag clears its preview on release, so the row must move before the save answers.
    const store = createTestStore()
    const updateFolderWorkspace = vi.fn(() => new Promise<boolean>(() => {}))
    store.setState({ folderWorkspaces: FOLDERS, updateFolderWorkspace })
    const metaUpdates = [...saved].map(([id, updates]) => ({ worktreeId: id, updates }))
    void store.getState().updateWorktreesMeta(metaUpdates)
    expect(updateFolderWorkspace).toHaveBeenCalled()
    const reorderedRows = buildSidebarRows('repo', store.getState().folderWorkspaces)
    expect(renderedFolderIds(reorderedRows)).toEqual([FOLDER_C, FOLDER_A, FOLDER_B])
  })

  it('saves only the dragged group when the selection spans worktrees and folders', () => {
    const worktrees = [
      { ...WORKTREE, id: 'wt-todo', manualOrder: 6000, workspaceStatus: 'todo' },
      { ...WORKTREE, id: 'wt-top', manualOrder: 5000 },
      { ...WORKTREE, id: 'wt-next', manualOrder: 4000 }
    ]
    const rows = buildSidebarRows('workspace-status', FOLDERS, worktrees)
    // A lane renders its folder workspaces after every worktree, so the two kinds drag apart.
    expect(getWorktreeDragGroups(rows).map((group) => group.worktreeIds)).toEqual([
      ['wt-todo'],
      ['wt-top', 'wt-next'],
      [FOLDER_A, FOLDER_B, FOLDER_C]
    ])

    // The other selected row keeps its rank; wt-next ranks above wt-top and fw-a below fw-c.
    expect(saveSlotDrop(rows, worktrees, ['wt-next', FOLDER_A], 0)).toEqual(
      new Map([['wt-next', { manualOrder: 5500 }]])
    )
    expect(saveSlotDrop(rows, worktrees, [FOLDER_A, 'wt-top'], 3)).toEqual(
      new Map([[FOLDER_A, { manualOrder: 0 }]])
    )
  })

  it('shows a folder workspace drag no board, status lane or pin target', () => {
    const { folderKey, worktreeKey } = statusLaneDragKeys()
    const worktreeFrame = flushOver(worktreeKey, WORKTREE.id)
    expect(worktreeFrame.onWorkspaceBoardDragPreviewStart).toHaveBeenCalled()
    expect(worktreeFrame.state.dropIndicatorY).toBe(300)

    // Those targets only move git worktrees, so a folder workspace drag must not offer them.
    const folderFrame = flushOver(folderKey, FOLDER_A)
    expect(folderFrame.onWorkspaceBoardDragPreviewStart).not.toHaveBeenCalled()
    expect(folderFrame.state.dropIndicatorY).toBeNull()
  })

  it('commits no status lane or pin drop for a folder workspace drag', () => {
    const { folderKey, worktreeKey } = statusLaneDragKeys()
    expect(releaseOver(worktreeKey, WORKTREE.id).onMoveWorktreesToStatusAtIndex).toHaveBeenCalled()

    expect(releaseOver(folderKey, FOLDER_A).onMoveWorktreesToStatusAtIndex).not.toHaveBeenCalled()
    const overPin = { getEligibleLineageDropTarget: () => PIN_TARGET }
    expect(releaseOver(folderKey, FOLDER_A, overPin).onPinWorktrees).not.toHaveBeenCalled()
  })
})
