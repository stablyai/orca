// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { readStoreListenerCount } from '@/store/store-listener-census'
import type * as ContextualTour from '@/components/contextual-tours/use-contextual-tour'
import type * as VisibleWorkspaceKanban from './use-visible-workspace-kanban-worktree-ids'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'

const { contentProbe, contextualTourMock } = vi.hoisted(() => ({
  contentProbe: {
    mounts: vi.fn(),
    projections: vi.fn(),
    renders: vi.fn(),
    storeNotifications: vi.fn(),
    unmounts: vi.fn()
  },
  contextualTourMock: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }))

vi.mock('@/components/ui/sheet', () => ({
  // Why: keep children mounted while closed so this measures Orca's gate, not Radix's portal.
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) => (
    <div data-sheet-open={open ? 'true' : 'false'}>{children}</div>
  ),
  SheetContent: ({
    children,
    'data-workspace-board-drag-preview': dragPreview
  }: {
    children: React.ReactNode
    'data-workspace-board-drag-preview'?: string
  }) => (
    <div data-workspace-board-drag-preview={dragPreview} data-slot="sheet-content">
      {children}
    </div>
  )
}))

vi.mock('./WorkspaceKanbanDrawerHeader', () => ({
  default: () => <div data-workspace-board-heavy-content="true" />
}))
vi.mock('./WorkspaceKanbanLaneGrid', () => ({ default: () => <div /> }))
vi.mock('./WorkspaceKanbanPinDropTarget', () => ({ default: () => <div /> }))
vi.mock('./WorkspaceKanbanAreaSelectionOverlay', () => ({
  default: React.forwardRef<HTMLDivElement>((_, ref) => <div ref={ref} />)
}))

vi.mock('./use-visible-workspace-kanban-worktree-ids', async (importOriginal) => {
  const actual = await importOriginal<typeof VisibleWorkspaceKanban>()
  return {
    ...actual,
    useVisibleWorkspaceKanbanWorktreeIds: (
      params: Parameters<typeof actual.useVisibleWorkspaceKanbanWorktreeIds>[0]
    ) => {
      const visibleIds = actual.useVisibleWorkspaceKanbanWorktreeIds(params)
      contentProbe.renders()
      contentProbe.projections()
      React.useEffect(() => {
        contentProbe.mounts()
        const unsubscribe = useAppStore.subscribe(() => contentProbe.storeNotifications())
        return () => {
          contentProbe.unmounts()
          unsubscribe()
        }
      }, [])
      return visibleIds
    }
  }
})

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
vi.mock('./use-workspace-kanban-card-pointer-drag', () => ({
  useWorkspaceKanbanCardPointerDrag: () => ({
    isPointerDragActiveRef: { current: false },
    onCardPointerDownCapture: vi.fn()
  })
}))
vi.mock('./use-workspace-kanban-shift-wheel-scroll', () => ({
  useWorkspaceKanbanShiftWheelScroll: vi.fn()
}))
vi.mock('./use-workspace-kanban-outside-dismiss', () => ({
  isWorkspaceBoardKeepOpenTarget: () => false,
  useWorkspaceKanbanOutsideDismiss: vi.fn()
}))
vi.mock('./use-workspace-status-drop', () => ({ useWorkspaceStatusDocumentDrop: vi.fn() }))
vi.mock('@/components/contextual-tours/use-contextual-tour', async (importOriginal) => {
  const actual = await importOriginal<typeof ContextualTour>()
  return {
    ...actual,
    useContextualTour: (...args: Parameters<typeof actual.useContextualTour>) => {
      contextualTourMock(...args)
      actual.useContextualTour(...args)
    }
  }
})

const initialAppState = useAppStore.getInitialState()
const onOpenChange = vi.fn()
const onMenuOpenChange = vi.fn()
let testContainer: HTMLDivElement
let testRoot: Root

function activeContentSubscriptions(): number {
  return contentProbe.mounts.mock.calls.length - contentProbe.unmounts.mock.calls.length
}

function requireStoreListenerCount(): number {
  const count = readStoreListenerCount()
  expect(count).not.toBeNull()
  return count ?? 0
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderDrawer(open: boolean, dragPreview = false): Promise<void> {
  await act(async () => {
    testRoot.render(
      <WorkspaceKanbanDrawer
        open={open}
        statusBarVisible={true}
        dragPreview={dragPreview}
        preserveOpenForMenu={false}
        onOpenChange={onOpenChange}
        onMenuOpenChange={onMenuOpenChange}
      />
    )
  })
  await flushEffects()
}

async function churnRemoteWorkspaceState(count: number): Promise<void> {
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      useAppStore.setState({
        worktreesByRepo: {},
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        browserTabsByWorktree: {},
        agentStatusEpoch: index
      })
    }
  })
}

describe('WorkspaceKanbanDrawer mount gating', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    Object.values(contentProbe).forEach((probe) => probe.mockClear())
    contextualTourMock.mockClear()
    onOpenChange.mockClear()
    onMenuOpenChange.mockClear()
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => testRoot.unmount())
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('unmounts heavy content after the close animation and isolates closed churn', async () => {
    const listenerBaseline = requireStoreListenerCount()
    await renderDrawer(false)
    const closedListenerCount = requireStoreListenerCount()

    expect(closedListenerCount).toBe(listenerBaseline)
    expect(testContainer.querySelector('[data-workspace-board-heavy-content]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(0)

    await renderDrawer(true)
    const openListenerCount = requireStoreListenerCount()
    expect(openListenerCount).toBeGreaterThan(closedListenerCount + 15)
    expect(activeContentSubscriptions()).toBe(1)

    await renderDrawer(false)
    expect(testContainer.querySelector('[data-sheet-open="false"]')).not.toBeNull()
    await act(async () => vi.advanceTimersByTimeAsync(299))
    expect(testContainer.querySelector('[data-workspace-board-heavy-content]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)

    const lingeringNotifications = contentProbe.storeNotifications.mock.calls.length
    await churnRemoteWorkspaceState(1)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(lingeringNotifications + 1)

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(testContainer.querySelector('[data-workspace-board-heavy-content]')).toBeNull()
    expect(activeContentSubscriptions()).toBe(0)
    expect(requireStoreListenerCount()).toBe(closedListenerCount)

    const hiddenProjectionCount = contentProbe.projections.mock.calls.length
    const hiddenRenderCount = contentProbe.renders.mock.calls.length
    const hiddenNotificationCount = contentProbe.storeNotifications.mock.calls.length
    await churnRemoteWorkspaceState(1_000)

    expect(contentProbe.projections).toHaveBeenCalledTimes(hiddenProjectionCount)
    expect(contentProbe.renders).toHaveBeenCalledTimes(hiddenRenderCount)
    expect(contentProbe.storeNotifications).toHaveBeenCalledTimes(hiddenNotificationCount)
  })

  it('cancels the pending unmount when reopened at 299 ms', async () => {
    await renderDrawer(true)
    await renderDrawer(false)
    await act(async () => vi.advanceTimersByTimeAsync(299))
    await renderDrawer(true)
    await act(async () => vi.advanceTimersByTimeAsync(1_000))

    expect(testContainer.querySelector('[data-sheet-open="true"]')).not.toBeNull()
    expect(testContainer.querySelector('[data-workspace-board-heavy-content]')).not.toBeNull()
    expect(activeContentSubscriptions()).toBe(1)
  })

  it('preserves drag preview presentation when the preview becomes a full board', async () => {
    await renderDrawer(true, true)

    expect(testContainer.querySelector('[data-workspace-board-drag-preview="true"]')).not.toBeNull()
    expect(contextualTourMock).toHaveBeenLastCalledWith(
      'workspace-board',
      false,
      'workspace_board_visible'
    )

    await renderDrawer(true, false)

    expect(testContainer.querySelector('[data-workspace-board-drag-preview]')).toBeNull()
    expect(contextualTourMock).toHaveBeenLastCalledWith(
      'workspace-board',
      true,
      'workspace_board_visible'
    )
    expect(contentProbe.mounts).toHaveBeenCalledTimes(1)
    expect(activeContentSubscriptions()).toBe(1)
  })
})
