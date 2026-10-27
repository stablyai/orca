// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import type { WorkspaceKanbanLaneView } from './workspace-kanban-search'

type GridCapture = {
  statuses: readonly WorkspaceStatusDefinition[]
  laneViews: ReadonlyMap<string, WorkspaceKanbanLaneView>
}

const { gridState } = vi.hoisted(() => ({ gridState: { current: null as GridCapture | null } }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('./WorkspaceKanbanDrawerHeader', () => ({ default: () => <div /> }))
vi.mock('./WorkspaceKanbanLaneGrid', () => ({
  default: (props: GridCapture) => {
    gridState.current = props
    return <div />
  }
}))
vi.mock('./WorkspaceKanbanAreaSelectionOverlay', () => ({
  default: React.forwardRef<HTMLDivElement>((_, ref) => <div ref={ref} />)
}))
vi.mock('./WorkspaceKanbanPinDropTarget', () => ({ default: () => <div /> }))
vi.mock('./use-visible-workspace-kanban-worktree-ids', () => ({
  useVisibleWorkspaceKanbanWorktreeIds: ({ allWorktrees }: { allWorktrees: readonly Worktree[] }) =>
    new Set(allWorktrees.map(getWorktreeHostIdentity))
}))
vi.mock('./use-workspace-kanban-create-worktree', () => ({
  useWorkspaceKanbanCreateWorktree: () => ({ createWorktreeForStatus: vi.fn() })
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
vi.mock('./use-workspace-status-drop', () => ({ useWorkspaceStatusDocumentDrop: vi.fn() }))

const hostCard = {
  id: 'repo-r::/today',
  repoId: 'repo-r',
  hostId: toRuntimeExecutionHostId('env-1'),
  displayName: 'Today',
  path: '/today',
  branch: 'feature/today',
  isPinned: false,
  sortOrder: 1,
  manualOrder: 1,
  lastActivityAt: 1,
  workspaceStatus: 'status-6'
} as unknown as Worktree

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gridState.current = null
  useAppStore.setState({
    repos: [{ id: 'repo-r', path: '/repo-r', name: 'repo-r' } as unknown as Repo],
    worktreesByRepo: { 'repo-r': [hostCard] },
    workspaceStatuses: [
      { id: 'in-progress', label: 'In progress' },
      { id: 'todo', label: 'Todo' }
    ],
    hostWorkspaceStatuses: {
      'env-1': [
        { id: 'status-6', label: '🔥 今天收尾' },
        { id: 'todo', label: 'Host todo' }
      ]
    },
    removedRuntimeEnvironmentIds: new Set(),
    sortBy: 'manual',
    recordFeatureInteraction: vi.fn()
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function renderDrawer(): void {
  act(() => {
    root.render(
      <WorkspaceKanbanDrawer
        open={true}
        statusBarVisible={true}
        dragPreview={false}
        preserveOpenForMenu={false}
        onOpenChange={vi.fn()}
        onMenuOpenChange={vi.fn()}
      />
    )
  })
}

function laneIds(status: string): string[] {
  return (gridState.current?.laneViews.get(status)?.items ?? []).map((item) => item.id)
}

describe('WorkspaceKanbanDrawer paired host columns', () => {
  it("puts a paired host's card in the host's own column, not the default one", () => {
    renderDrawer()

    expect(gridState.current?.statuses).toEqual([
      { id: 'in-progress', label: 'In progress' },
      { id: 'todo', label: 'Todo' },
      { id: 'status-6', label: '🔥 今天收尾' }
    ])
    expect(laneIds('status-6')).toEqual([hostCard.id])
    expect(laneIds('in-progress')).toEqual([])
  })

  it('drops a removed host’s columns', () => {
    useAppStore.setState({ removedRuntimeEnvironmentIds: new Set(['env-1']) })
    renderDrawer()

    expect(gridState.current?.statuses.map((status) => status.id)).toEqual(['in-progress', 'todo'])
  })
})
