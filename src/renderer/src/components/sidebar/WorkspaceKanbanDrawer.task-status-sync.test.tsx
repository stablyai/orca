// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo, Worktree } from '../../../../shared/types'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import type * as WorkspaceBoardTaskStatusSync from './workspace-board-task-status-sync'

type PointerDragParams = {
  onDropWorktreesInStatus: (args: {
    worktreeIds: readonly string[]
    status: string
    dropIndex: number
  }) => void
  onPinWorktrees: (worktreeIds: readonly string[]) => void
}

type DocumentDropCapture = {
  onMoveWorktreeToStatus: (worktreeId: string, status: string) => void
  onPinWorktree: (worktreeId: string) => void
  options?: {
    onMoveWorktreesToStatus?: (worktreeIds: readonly string[], status: string) => void
    onPinWorktrees?: (worktreeIds: readonly string[]) => void
  }
}

const {
  syncWorkspaceBoardTaskStatusesMock,
  toastErrorMock,
  toastWarningMock,
  pointerDragState,
  documentDropState
} = vi.hoisted(() => ({
  syncWorkspaceBoardTaskStatusesMock: vi.fn(() =>
    Promise.resolve({
      updated: 1,
      skipped: 0,
      failed: 0,
      messages: [] as WorkspaceBoardTaskStatusSync.WorkspaceBoardTaskStatusSyncMessage[]
    })
  ),
  toastErrorMock: vi.fn(),
  toastWarningMock: vi.fn(),
  pointerDragState: { current: null as PointerDragParams | null },
  documentDropState: { current: null as DocumentDropCapture | null }
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock,
    warning: toastWarningMock
  }
}))

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({
    children,
    overlayStyle,
    style
  }: {
    children: React.ReactNode
    overlayStyle?: React.CSSProperties
    style?: React.CSSProperties
  }) => (
    <>
      <div data-slot="sheet-overlay" style={overlayStyle} />
      <div data-slot="sheet-content" style={style}>
        {children}
      </div>
    </>
  )
}))

vi.mock('./WorkspaceKanbanDrawerHeader', () => ({
  default: () => <div data-testid="workspace-board-header" />
}))

vi.mock('./WorkspaceKanbanLaneGrid', () => ({
  default: () => <div data-testid="workspace-board-lanes" />
}))

vi.mock('./WorkspaceKanbanAreaSelectionOverlay', () => ({
  default: React.forwardRef<HTMLDivElement>((_, ref) => <div ref={ref} />)
}))

vi.mock('./WorkspaceKanbanPinDropTarget', () => ({
  default: () => <div data-testid="workspace-board-pin-target" />
}))

vi.mock('./use-visible-workspace-kanban-worktree-ids', () => ({
  useVisibleWorkspaceKanbanWorktreeIds: ({ allWorktrees }: { allWorktrees: readonly Worktree[] }) =>
    new Set(allWorktrees.map((worktree) => worktree.id))
}))

vi.mock('./use-workspace-kanban-selection', () => ({
  useWorkspaceKanbanSelection: () => ({
    selectedWorktreeIds: new Set<string>(),
    selectedWorktrees: [],
    selectionAnchorId: null,
    updateSelectionForGesture: vi.fn(),
    updateSelectionForArea: vi.fn(),
    clearSelection: vi.fn(),
    selectForContextMenu: vi.fn(() => [])
  })
}))

vi.mock('./use-workspace-kanban-area-selection', () => ({
  useWorkspaceKanbanAreaSelection: () => ({
    handleAreaSelectionPointerDown: vi.fn()
  })
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
  useWorkspaceKanbanCardPointerDrag: (params: PointerDragParams) => {
    pointerDragState.current = params
    return {
      isPointerDragActiveRef: { current: false },
      onCardPointerDownCapture: vi.fn()
    }
  }
}))

vi.mock('./use-workspace-status-drop', () => ({
  useWorkspaceStatusDocumentDrop: (
    _containerRef: unknown,
    onMoveWorktreeToStatus: DocumentDropCapture['onMoveWorktreeToStatus'],
    onPinWorktree: DocumentDropCapture['onPinWorktree'],
    _onDragFinish: () => void,
    _enabled: boolean,
    options?: DocumentDropCapture['options']
  ) => {
    documentDropState.current = { onMoveWorktreeToStatus, onPinWorktree, options }
  }
}))

vi.mock('./workspace-board-task-status-sync', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkspaceBoardTaskStatusSync>()
  return {
    ...actual,
    syncWorkspaceBoardTaskStatuses: syncWorkspaceBoardTaskStatusesMock
  }
})

let container: HTMLDivElement
let root: Root
let consoleInfoSpy: ReturnType<typeof vi.spyOn>
let consoleWarnSpy: ReturnType<typeof vi.spyOn>

const statuses = [
  { id: 'todo', label: 'Todo' },
  { id: 'in-review', label: 'In review' }
]

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-a::/worktree-a',
    repoId: 'repo-a',
    displayName: 'Worktree A',
    path: '/worktree-a',
    branch: 'feature/a',
    baseBranch: 'main',
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    workspaceStatus: 'todo',
    linkedLinearIssue: 'ORC-1',
    linkedLinearIssueWorkspaceId: 'workspace-1',
    ...overrides
  } as Worktree
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-a',
    path: '/repo-a',
    name: 'repo-a',
    connectionId: null,
    executionHostId: 'runtime:owner-env',
    ...overrides
  } as Repo
}

function renderDrawer(item: Worktree, enabled = true, statusBarVisible = true): void {
  const updateWorktreeMeta = vi.fn()
  const updateWorktreesMeta = vi.fn()
  const recordFeatureInteraction = vi.fn()
  useAppStore.setState({
    repos: [repo()],
    worktreesByRepo: { 'repo-a': [item] },
    activeWorktreeId: item.id,
    workspaceStatuses: statuses,
    syncTaskStatusFromWorkspaceBoard: enabled,
    setSyncTaskStatusFromWorkspaceBoard: vi.fn(),
    workspaceBoardColumnWidth: 308,
    sidebarOpen: true,
    sidebarWidth: 280,
    sortBy: 'manual',
    updateWorktreeMeta,
    updateWorktreesMeta,
    getKnownWorktreeById: (worktreeId: string) => (worktreeId === item.id ? item : undefined),
    recordFeatureInteraction
  })

  act(() => {
    root.render(
      <WorkspaceKanbanDrawer
        open={true}
        statusBarVisible={statusBarVisible}
        dragPreview={false}
        preserveOpenForMenu={false}
        onOpenChange={vi.fn()}
        onMenuOpenChange={vi.fn()}
      />
    )
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  pointerDragState.current = null
  documentDropState.current = null
  syncWorkspaceBoardTaskStatusesMock.mockClear()
  toastErrorMock.mockClear()
  toastWarningMock.mockClear()
  consoleInfoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  consoleInfoSpy.mockRestore()
  consoleWarnSpy.mockRestore()
  container.remove()
})

describe('WorkspaceKanbanDrawer task status sync wiring', () => {
  it('reserves the status bar row in the board sheet and overlay when visible', () => {
    renderDrawer(worktree(), true, true)

    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')
    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')

    expect(sheet?.style.top).toBe('36px')
    expect(sheet?.style.bottom).toBe('24px')
    expect(sheet?.style.height).toBe('auto')
    expect(overlay?.style.top).toBe('36px')
    expect(overlay?.style.bottom).toBe('24px')
    expect(overlay?.style.pointerEvents).toBe('none')
  })

  it('keeps the board sheet and overlay flush to the viewport bottom when status bar is hidden', () => {
    renderDrawer(worktree(), true, false)

    const sheet = document.querySelector<HTMLElement>('[data-slot="sheet-content"]')
    const overlay = document.querySelector<HTMLElement>('[data-slot="sheet-overlay"]')

    expect(sheet?.style.top).toBe('36px')
    expect(sheet?.style.bottom).toBe('0px')
    expect(sheet?.style.height).toBe('auto')
    expect(overlay?.style.top).toBe('36px')
    expect(overlay?.style.bottom).toBe('0px')
    expect(overlay?.style.pointerEvents).toBe('none')
  })

  it('syncs Linear after a document-drop status move when the setting is enabled', () => {
    const item = worktree()
    renderDrawer(item)

    act(() => {
      documentDropState.current?.onMoveWorktreeToStatus(item.id, 'in-review')
    })

    expect(syncWorkspaceBoardTaskStatusesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeIds: [item.id],
        targetStatus: { id: 'in-review', label: 'In review' },
        getSettingsForWorktree: expect.any(Function),
        getLatestWorkspaceStatus: expect.any(Function)
      })
    )
  })

  it('does not sync when a document-drop status move happens while disabled', () => {
    const item = worktree()
    renderDrawer(item, false)

    act(() => {
      documentDropState.current?.onMoveWorktreeToStatus(item.id, 'in-review')
    })

    expect(syncWorkspaceBoardTaskStatusesMock).not.toHaveBeenCalled()
  })

  it('syncs pointer-drop status changes through the board callback', () => {
    const item = worktree()
    renderDrawer(item)

    act(() => {
      pointerDragState.current?.onDropWorktreesInStatus({
        worktreeIds: [item.id],
        status: 'in-review',
        dropIndex: 0
      })
    })

    expect(syncWorkspaceBoardTaskStatusesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeIds: [item.id],
        targetStatus: { id: 'in-review', label: 'In review' }
      })
    )
  })

  it('does not sync manual-order-only drops that keep the same board status', () => {
    const item = worktree({ workspaceStatus: 'in-review' })
    renderDrawer(item)

    act(() => {
      pointerDragState.current?.onDropWorktreesInStatus({
        worktreeIds: [item.id],
        status: 'in-review',
        dropIndex: 0
      })
    })

    expect(syncWorkspaceBoardTaskStatusesMock).not.toHaveBeenCalled()
  })

  it('does not sync pin-only paths', () => {
    const item = worktree()
    renderDrawer(item)

    act(() => {
      pointerDragState.current?.onPinWorktrees([item.id])
      documentDropState.current?.onPinWorktree(item.id)
      documentDropState.current?.options?.onPinWorktrees?.([item.id])
    })

    expect(syncWorkspaceBoardTaskStatusesMock).not.toHaveBeenCalled()
  })

  it('shows a warning toast when task status sync is skipped with a message', async () => {
    syncWorkspaceBoardTaskStatusesMock.mockResolvedValueOnce({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'missing-workflow-state', statusLabel: 'In review' }]
    })
    const item = worktree()
    renderDrawer(item)

    await act(async () => {
      documentDropState.current?.onMoveWorktreeToStatus(item.id, 'in-review')
      await Promise.resolve()
    })

    expect(toastWarningMock).toHaveBeenCalledWith(
      'Task status sync skipped',
      expect.objectContaining({
        description: '1 skipped. No matching Linear workflow state for In review.'
      })
    )
  })

  it('shows an error toast when task status sync unexpectedly rejects', async () => {
    syncWorkspaceBoardTaskStatusesMock.mockRejectedValueOnce(new Error('Runtime disconnected'))
    const item = worktree()
    renderDrawer(item)

    await act(async () => {
      documentDropState.current?.onMoveWorktreeToStatus(item.id, 'in-review')
      await Promise.resolve()
    })

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Workspace board task status sync failed',
      expect.any(Error)
    )
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Task status sync failed',
      expect.objectContaining({
        description: '1 failed. Task status sync could not finish.'
      })
    )
  })
})
