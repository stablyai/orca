// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_PALETTE_QUERY_MAX_BYTES } from '@/lib/worktree-palette-query-bounds'
import { useAppStore } from '@/store'
import type { Repo, Worktree, WorktreeMeta } from '../../../../shared/types'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import type { WorkspaceKanbanLaneView } from './workspace-kanban-search'

type HeaderCapture = {
  selectedCount: number
  query: string
  isFiltering: boolean
  isTooLarge: boolean
  matchCount: number
  totalCount: number
  onQueryChange: (query: string) => void
  onClearQuery: () => void
}

type GridCapture = {
  laneViews: ReadonlyMap<string, WorkspaceKanbanLaneView>
  laneFullWorktreeIds: ReadonlyMap<string, readonly string[]>
  hasQuery: boolean
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
}

type PointerDragCapture = {
  selectedWorktrees: readonly Worktree[]
  onDropWorktreesInStatus: (args: {
    worktreeIds: readonly string[]
    status: string
    dropIndex: number
  }) => void
}

const {
  syncWorkspaceBoardTaskStatusesMock,
  headerState,
  gridState,
  pointerDragState,
  selectionState,
  selectionScopeState
} = vi.hoisted(() => ({
  syncWorkspaceBoardTaskStatusesMock: vi.fn(() =>
    Promise.resolve({ updated: 1, skipped: 0, failed: 0, messages: [] })
  ),
  headerState: { current: null as HeaderCapture | null },
  gridState: { current: null as GridCapture | null },
  pointerDragState: { current: null as PointerDragCapture | null },
  selectionState: { current: [] as Worktree[] },
  selectionScopeState: { current: [] as readonly Worktree[] }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./WorkspaceKanbanDrawerHeader', () => ({
  default: (props: HeaderCapture) => {
    headerState.current = props
    return <div data-testid="workspace-board-header" />
  }
}))

vi.mock('./WorkspaceKanbanLaneGrid', () => ({
  default: (props: GridCapture) => {
    gridState.current = props
    return <div data-testid="workspace-board-lanes" />
  }
}))

vi.mock('./WorkspaceKanbanAreaSelectionOverlay', () => ({
  default: React.forwardRef<HTMLDivElement>((_, ref) => <div ref={ref} />)
}))

vi.mock('./WorkspaceKanbanPinDropTarget', () => ({ default: () => <div /> }))

vi.mock('./use-visible-workspace-kanban-worktree-ids', () => ({
  useVisibleWorkspaceKanbanWorktreeIds: ({ allWorktrees }: { allWorktrees: readonly Worktree[] }) =>
    new Set(allWorktrees.map((worktree) => worktree.id))
}))

vi.mock('./use-workspace-kanban-selection', () => ({
  useWorkspaceKanbanSelection: (
    _open: boolean,
    boardWorktrees: readonly Worktree[],
    renderedWorktrees?: readonly Worktree[]
  ) => {
    selectionScopeState.current = renderedWorktrees ?? boardWorktrees
    return {
      selectedWorktreeIds: new Set(selectionState.current.map((worktree) => worktree.id)),
      selectedWorktrees: selectionState.current,
      selectionAnchorId: null,
      updateSelectionForGesture: vi.fn(),
      updateSelectionForArea: vi.fn(),
      clearSelection: vi.fn(),
      selectForContextMenu: vi.fn(() => selectionState.current)
    }
  }
}))

vi.mock('./use-workspace-kanban-area-selection', () => ({
  useWorkspaceKanbanAreaSelection: () => ({ handleAreaSelectionPointerDown: vi.fn() })
}))

vi.mock('./use-workspace-kanban-column-resize', () => ({
  useWorkspaceKanbanColumnResize: () => ({
    columnWidth: 308,
    isResizingColumn: false,
    onColumnResizeStart: vi.fn(),
    onColumnResizeKeyDown: vi.fn()
  })
}))

vi.mock('./use-workspace-kanban-create-worktree', () => ({
  useWorkspaceKanbanCreateWorktree: () => ({
    canCreateWorktree: true,
    createWorktreeForStatus: vi.fn()
  })
}))

vi.mock('./use-workspace-kanban-shift-wheel-scroll', () => ({
  useWorkspaceKanbanShiftWheelScroll: vi.fn()
}))

vi.mock('./use-workspace-kanban-outside-dismiss', () => ({
  isWorkspaceBoardKeepOpenTarget: () => false,
  useWorkspaceKanbanOutsideDismiss: vi.fn()
}))

vi.mock('@/components/contextual-tours/use-contextual-tour', () => ({
  useContextualTour: vi.fn()
}))

vi.mock('./use-workspace-kanban-card-pointer-drag', () => ({
  useWorkspaceKanbanCardPointerDrag: (params: PointerDragCapture) => {
    pointerDragState.current = params
    return { isPointerDragActiveRef: { current: false }, onCardPointerDownCapture: vi.fn() }
  }
}))

vi.mock('./use-workspace-status-drop', () => ({
  useWorkspaceStatusDocumentDrop: vi.fn()
}))

vi.mock('./workspace-board-task-status-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncWorkspaceBoardTaskStatuses: syncWorkspaceBoardTaskStatusesMock
}))

type UpdateWorktreesMeta = (
  updatesByWorktreeId: ReadonlyMap<string, Partial<WorktreeMeta>>
) => Promise<void>

const statuses = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-review', label: 'In review' }
]

function worktree(name: string, manualOrder: number, workspaceStatus: string): Worktree {
  return {
    id: `repo-a::/${name.toLowerCase()}`,
    repoId: 'repo-a',
    displayName: name,
    path: `/${name.toLowerCase()}`,
    branch: `feature/${name.toLowerCase()}`,
    baseBranch: 'main',
    isPinned: false,
    sortOrder: manualOrder,
    manualOrder,
    lastActivityAt: 1,
    workspaceStatus
  } as unknown as Worktree
}

const alpha = worktree('Alpha', 100, 'todo')
const beta = worktree('Beta', 200, 'todo')
const gamma = worktree('Gamma', 300, 'todo')
const delta = worktree('Delta', 400, 'todo')
const omega = worktree('Omega', 100, 'in-review')
const allWorktrees = [alpha, beta, gamma, delta, omega]

let container: HTMLDivElement
let root: Root
let updateWorktreesMeta: ReturnType<typeof vi.fn<UpdateWorktreesMeta>>

function renderDrawer(open = true): void {
  act(() => {
    root.render(
      <WorkspaceKanbanDrawer
        open={open}
        statusBarVisible={true}
        dragPreview={false}
        preserveOpenForMenu={false}
        onOpenChange={vi.fn()}
        onMenuOpenChange={vi.fn()}
      />
    )
  })
}

function typeQuery(query: string): void {
  act(() => {
    headerState.current?.onQueryChange(query)
  })
}

function laneIds(status: string): string[] {
  return (gridState.current?.laneViews.get(status)?.items ?? []).map((item) => item.id)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  headerState.current = null
  gridState.current = null
  pointerDragState.current = null
  selectionState.current = []
  selectionScopeState.current = []
  syncWorkspaceBoardTaskStatusesMock.mockClear()
  updateWorktreesMeta = vi.fn<UpdateWorktreesMeta>(() => Promise.resolve())
  useAppStore.setState({
    repos: [
      { id: 'repo-a', path: '/repo-a', name: 'repo-a', connectionId: null } as unknown as Repo
    ],
    worktreesByRepo: { 'repo-a': allWorktrees },
    activeWorktreeId: alpha.id,
    workspaceStatuses: statuses,
    syncTaskStatusFromWorkspaceBoard: true,
    setSyncTaskStatusFromWorkspaceBoard: vi.fn(),
    workspaceBoardColumnWidth: 308,
    sidebarOpen: true,
    sidebarWidth: 280,
    sortBy: 'manual',
    updateWorktreeMeta: vi.fn(),
    updateWorktreesMeta,
    getKnownWorktreeById: (id: string) => allWorktrees.find((item) => item.id === id),
    recordFeatureInteraction: vi.fn()
  })
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('WorkspaceKanbanDrawer search', () => {
  it('filters every lane in place and reports lane totals', () => {
    renderDrawer()
    expect(laneIds('todo')).toHaveLength(4)

    typeQuery('gamma')

    expect(laneIds('todo')).toEqual([gamma.id])
    expect(laneIds('in-review')).toEqual([])
    expect(gridState.current?.hasQuery).toBe(true)
    expect(gridState.current?.laneViews.get('todo')?.totalCount).toBe(4)
    expect(gridState.current?.laneViews.get('in-review')?.totalCount).toBe(1)
    expect(headerState.current).toMatchObject({ matchCount: 1, totalCount: 5 })
  })

  it('restores every lane when the query is cleared', () => {
    renderDrawer()
    typeQuery('gamma')

    act(() => {
      headerState.current?.onClearQuery()
    })

    expect(laneIds('todo')).toHaveLength(4)
    expect(laneIds('in-review')).toEqual([omega.id])
    expect(gridState.current?.hasQuery).toBe(false)
  })

  it('drops the query when the board closes so a reopen starts unfiltered', () => {
    renderDrawer()
    typeQuery('gamma')
    expect(headerState.current?.query).toBe('gamma')

    renderDrawer(false)
    renderDrawer(true)

    expect(headerState.current?.query).toBe('')
    expect(laneIds('todo')).toHaveLength(4)
  })

  it('still runs the Linear status sync for a drop made under an active query', () => {
    renderDrawer()
    typeQuery('gamma')

    act(() => {
      pointerDragState.current?.onDropWorktreesInStatus({
        worktreeIds: [omega.id],
        status: 'todo',
        dropIndex: 0
      })
    })

    expect(syncWorkspaceBoardTaskStatusesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeIds: [omega.id],
        targetStatus: { id: 'todo', label: 'Todo' }
      })
    )
  })

  it('narrows the pointer-drag payload to the rendered cards', () => {
    selectionState.current = [alpha, gamma]
    renderDrawer()
    expect(pointerDragState.current?.selectedWorktrees).toEqual([alpha, gamma])

    typeQuery('gamma')

    expect(pointerDragState.current?.selectedWorktrees).toEqual([gamma])
  })

  it('narrows the context-menu "Move to Status" payload to the rendered cards', () => {
    selectionState.current = [alpha, gamma]
    renderDrawer()
    typeQuery('gamma')

    const event = {} as React.MouseEvent<HTMLElement>
    expect(gridState.current?.onContextMenuSelect(event, gamma)).toEqual([gamma])
  })

  it('keeps selection highlighting unfiltered while a query is active', () => {
    selectionState.current = [alpha, gamma]
    renderDrawer()
    typeQuery('gamma')

    expect(gridState.current?.selectedWorktreeIds.has(alpha.id)).toBe(true)
    expect(gridState.current?.selectedWorktrees).toEqual([gamma])
  })

  it('counts only the rendered cards in the header selection badge', () => {
    selectionState.current = [alpha, gamma]
    renderDrawer()
    expect(headerState.current?.selectedCount).toBe(2)

    typeQuery('gamma')

    expect(headerState.current?.selectedCount).toBe(1)
  })

  it('scopes selection gestures to the rendered cards', () => {
    renderDrawer()
    expect(selectionScopeState.current).toHaveLength(5)

    typeQuery('gamma')

    expect(selectionScopeState.current).toEqual([gamma])
  })

  it('reports a non-filtering query so the header withholds match counts', () => {
    renderDrawer()

    typeQuery('   ')

    expect(headerState.current).toMatchObject({ isFiltering: false, matchCount: 5, totalCount: 5 })
    expect(laneIds('todo')).toHaveLength(4)
  })

  it('leaves the whole board unfiltered for an over-bound query', () => {
    // Why: searchWorktrees returns [] past the byte bound, which would read as
    // "matched nothing" and blank every lane on a paste accident.
    renderDrawer()

    typeQuery('x'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES + 1))

    expect(laneIds('todo')).toHaveLength(4)
    expect(laneIds('in-review')).toEqual([omega.id])
    expect(gridState.current?.hasQuery).toBe(false)
    expect(headerState.current).toMatchObject({
      isFiltering: false,
      isTooLarge: true,
      matchCount: 5,
      totalCount: 5
    })
  })

  it('ranks a drop into a filtered lane against the full lane, not the rendered one', () => {
    renderDrawer()
    typeQuery('gamma')

    act(() => {
      // Manual order is descending, so the lane is Delta, Gamma, Beta, Alpha.
      // Rendered index 0 means "above Gamma" — full-lane index 1, not the top.
      pointerDragState.current?.onDropWorktreesInStatus({
        worktreeIds: [omega.id],
        status: 'todo',
        dropIndex: 0
      })
    })

    const dropped = updateWorktreesMeta.mock.calls.at(-1)?.[0].get(omega.id)
    expect(dropped?.workspaceStatus).toBe('todo')
    expect(dropped?.manualOrder).toBeGreaterThan(gamma.manualOrder ?? 0)
    expect(dropped?.manualOrder).toBeLessThan(delta.manualOrder ?? 0)
  })
})
