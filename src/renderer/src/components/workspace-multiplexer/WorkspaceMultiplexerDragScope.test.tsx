/** @vitest-environment happy-dom */
import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import type { DndContext, DragMoveEvent } from '@dnd-kit/core'
import type * as DndKit from '@dnd-kit/core'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkspaceMultiplexerDragScope } from './WorkspaceMultiplexerDragScope'

let handlers: ComponentProps<typeof DndContext>
vi.mock('@dnd-kit/core', async (importOriginal) => ({
  ...(await importOriginal<typeof DndKit>()),
  DndContext: (props: ComponentProps<typeof DndContext>) => {
    handlers = props
    return props.children
  },
  DragOverlay: () => null
}))
vi.mock('../tab-group/useTabDragSplit', () => ({
  useTabDragSplit: () => ({
    activeDrag: null,
    isTabDragActiveRef: { current: false },
    onDragCancel: vi.fn()
  })
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ workspaceMultiplexer: { panes: [] } }) }
}))

afterEach(() => document.body.replaceChildren())

it.each(['cancel', 'end'] as const)('ignores late workspace moves after drag %s', (finish) => {
  const container = document.createElement('div')
  container.dataset.workspaceMultiplexerPaneId = 'target'
  container.getBoundingClientRect = () => new DOMRect(0, 0, 800, 600)
  document.body.append(container)
  const root = createRoot(container)
  act(() =>
    root.render(
      <WorkspaceMultiplexerDragScope worktreeId="wt" onWorkspaceDrop={vi.fn()}>
        {({ hoveredWorkspaceDropTarget }) => (
          <span>{hoveredWorkspaceDropTarget?.zone ?? 'idle'}</span>
        )}
      </WorkspaceMultiplexerDragScope>
    )
  )
  const event = {
    active: {
      id: 'slot',
      data: { current: { kind: 'workspace-multiplexer-slot', slotId: 'slot', paneId: 'source' } }
    },
    over: {
      id: 'target',
      data: { current: { kind: 'workspace-multiplexer-pane', paneId: 'target' } }
    },
    activatorEvent: { clientX: 790, clientY: 300 },
    delta: { x: 0, y: 0 }
  } as unknown as DragMoveEvent
  try {
    act(() => handlers.onDragStart!(event))
    act(() => handlers.onDragMove!(event))
    expect(container.textContent).toBe('right')
    expect(document.querySelector('.tab-drop-overlay')).not.toBeNull()
    act(() =>
      finish === 'cancel'
        ? handlers.onDragCancel!(event)
        : handlers.onDragEnd!({ ...event, over: null })
    )
    expect(container.textContent).toBe('idle')
    act(() => handlers.onDragMove!(event))
    expect(container.textContent).toBe('idle')
    expect(document.querySelector('.tab-drop-overlay')).toBeNull()
  } finally {
    act(() => root.unmount())
  }
})
