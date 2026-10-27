// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../shared/worktree/types'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import type { WorkspaceKanbanLaneView } from './workspace-kanban-search'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

type GridCapture = {
  statuses: readonly WorkspaceStatusDefinition[]
  laneViews: ReadonlyMap<string, WorkspaceKanbanLaneView>
}

type HeaderCapture = {
  onAddStatus: () => void
  onRemoveStatus: (statusId: string) => void
}

const { gridState, headerState, syncState } = vi.hoisted(() => {
  const grid: { current: GridCapture | null } = { current: null }
  const header: { current: HeaderCapture | null } = { current: null }
  const sync: { statuses: readonly WorkspaceStatusDefinition[] } = { statuses: [] }
  return { gridState: grid, headerState: header, syncState: sync }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))
vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
vi.mock('./WorkspaceKanbanDrawerHeader', () => ({
  default: (props: HeaderCapture) => {
    headerState.current = props
    return <div />
  }
}))
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
vi.mock('./use-workspace-board-task-status-sync', () => ({
  useWorkspaceBoardTaskStatusSync: (args: {
    workspaceStatuses: readonly WorkspaceStatusDefinition[]
  }) => {
    syncState.statuses = args.workspaceStatuses
    return vi.fn()
  }
}))

const hostCard = makeWorktree({
  id: 'repo-r::/today',
  repoId: 'repo-r',
  hostId: toRuntimeExecutionHostId('env-1'),
  displayName: 'Today',
  path: '/today',
  branch: 'feature/today',
  sortOrder: 1,
  manualOrder: 1,
  lastActivityAt: 1,
  workspaceStatus: 'status-6'
})

const localCard = makeWorktree({
  ...hostCard,
  id: 'repo-l::/local',
  repoId: 'repo-l',
  hostId: undefined,
  path: '/local',
  workspaceStatus: 'in-progress'
})

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#999999', addedAt: 1 }
}

let container: HTMLDivElement
let root: Root
let updateWorktreeMeta: ReturnType<typeof vi.fn<AppState['updateWorktreeMeta']>>
let setWorkspaceStatuses: ReturnType<typeof vi.fn<(statuses: WorkspaceStatusDefinition[]) => void>>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  gridState.current = null
  headerState.current = null
  updateWorktreeMeta = vi.fn<AppState['updateWorktreeMeta']>(() => Promise.resolve({ ok: true }))
  setWorkspaceStatuses = vi.fn<(statuses: WorkspaceStatusDefinition[]) => void>()
  useAppStore.setState({
    repos: [makeRepo('repo-r'), makeRepo('repo-l')],
    worktreesByRepo: { 'repo-r': [hostCard], 'repo-l': [localCard] },
    updateWorktreeMeta,
    setWorkspaceStatuses,
    workspaceStatuses: [
      { id: 'in-progress', label: 'In progress' },
      { id: 'todo', label: 'Todo' }
    ],
    hostWorkspaceStatuses: {
      'env-1': [
        { id: 'status-6', label: '🔥 今天收尾' },
        { id: 'todo', label: 'Host todo' },
        { id: 'status-7', label: 'No card here' }
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
    expect(laneIds('in-progress')).toEqual([localCard.id])
  })

  it('never rewrites a host card in a host-only column when the local default column is removed', () => {
    renderDrawer()

    act(() => headerState.current?.onRemoveStatus('in-progress'))

    expect(setWorkspaceStatuses).toHaveBeenCalledWith([{ id: 'todo', label: 'Todo' }])
    expect(updateWorktreeMeta.mock.calls.map(([id]) => id)).toEqual([localCard.id])
  })

  it('never rewrites a host card whose own host still defines the removed column id', () => {
    const hostTodoCard = { ...hostCard, id: 'repo-r::/repo-r/todo', workspaceStatus: 'todo' }
    useAppStore.setState({
      worktreesByRepo: {
        'repo-r': [hostTodoCard],
        'repo-l': [{ ...localCard, workspaceStatus: 'todo' }]
      }
    })
    renderDrawer()

    act(() => headerState.current?.onRemoveStatus('todo'))

    expect(updateWorktreeMeta.mock.calls.map(([id]) => id)).toEqual([localCard.id])
  })

  it("gives a new local column an id no paired host's column already uses", () => {
    useAppStore.setState({
      workspaceStatuses: [{ id: 'in-progress', label: 'In progress' }],
      hostWorkspaceStatuses: { 'env-1': [{ id: 'status-2', label: 'Host lane' }] }
    })
    renderDrawer()

    act(() => headerState.current?.onAddStatus())

    const added = setWorkspaceStatuses.mock.calls[0]?.[0] ?? []
    expect(added.map((status) => status.id)).toEqual(['in-progress', expect.any(String)])
    expect(added[1]?.id).not.toBe('status-2')
  })

  it("lets task sync find a host column no card uses yet, as the card's menu offers it", () => {
    renderDrawer()

    expect(syncState.statuses.map((status) => status.id)).toContain('status-7')
    expect(gridState.current?.statuses.map((status) => status.id)).not.toContain('status-7')
  })

  it('drops a removed host’s columns', () => {
    useAppStore.setState({ removedRuntimeEnvironmentIds: new Set(['env-1']) })
    renderDrawer()

    expect(gridState.current?.statuses.map((status) => status.id)).toEqual(['in-progress', 'todo'])
  })
})
