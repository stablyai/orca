// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX,
  type ProjectGroupHeaderDragController,
  type UseProjectGroupHeaderDragArgs
} from './project-group-header-drag-contract'
import { useProjectGroupHeaderDrag } from './project-group-header-drag'
import type { ProjectGroup } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  createProjectGroupReparentIndex: vi.fn(() => ({
    subtreeIds: new Set(['group-a']),
    validate: () => null
  })),
  measureProjectGroupHeaderDragRects: vi.fn(() => [])
}))

vi.mock('../../../../shared/project-group-reparent', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createProjectGroupReparentIndex: mocks.createProjectGroupReparentIndex
}))

vi.mock('./project-group-header-drop', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  measureProjectGroupHeaderDragRects: mocks.measureProjectGroupHeaderDragRects
}))

const roots: Root[] = []
let controller: ProjectGroupHeaderDragController | null = null

function group(id: string): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function DragHarness(args: UseProjectGroupHeaderDragArgs): null {
  controller = useProjectGroupHeaderDrag(args)
  return null
}

async function renderDragHarness(scrollContainer: HTMLElement): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host, scrollContainer)
  const root = createRoot(host)
  roots.push(root)

  await act(async () => {
    root.render(
      <DragHarness
        sidebarProjectGroupHeaderIdsByBucket={new Map([['root', ['group-a', 'group-b']]])}
        totalProjectGroupHeaderCount={2}
        projectGroupById={
          new Map([
            ['group-a', group('group-a')],
            ['group-b', group('group-b')]
          ])
        }
        onCommitProjectGroupTabOrder={vi.fn()}
        onCommitProjectGroupReparent={vi.fn()}
        getScrollContainer={() => scrollContainer}
      />
    )
  })
}

function dispatchPointerMove(pointerId: number, clientX: number): void {
  window.dispatchEvent(
    new PointerEvent('pointermove', {
      pointerId,
      clientX,
      clientY: 20,
      bubbles: true
    })
  )
}

describe('useProjectGroupHeaderDrag promotion', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
  })

  afterEach(() => {
    roots.splice(0).forEach((root) => {
      act(() => root.unmount())
    })
    controller = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('creates the reparent index once only after crossing the drag threshold', async () => {
    const scrollContainer = document.createElement('div')
    const handle = document.createElement('div')
    handle.setAttribute('data-project-group-header-drag-handle', '')
    handle.setPointerCapture = vi.fn()
    handle.releasePointerCapture = vi.fn()
    scrollContainer.append(handle)
    await renderDragHarness(scrollContainer)

    await act(async () => {
      controller?.onHandlePointerDown(
        {
          button: 0,
          pointerId: 7,
          clientX: 10,
          clientY: 20,
          target: handle,
          currentTarget: handle
        } as unknown as React.PointerEvent<HTMLElement>,
        'group-a'
      )
    })

    act(() => {
      dispatchPointerMove(7, 10 + PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX - 1)
    })
    expect(mocks.createProjectGroupReparentIndex).not.toHaveBeenCalled()
    expect(mocks.measureProjectGroupHeaderDragRects).not.toHaveBeenCalled()

    act(() => {
      dispatchPointerMove(7, 10 + PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX)
    })
    expect(mocks.createProjectGroupReparentIndex).toHaveBeenCalledTimes(1)
    expect(mocks.measureProjectGroupHeaderDragRects).toHaveBeenCalledTimes(1)

    act(() => {
      dispatchPointerMove(7, 10 + PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX + 1)
    })
    expect(mocks.createProjectGroupReparentIndex).toHaveBeenCalledTimes(1)
    expect(mocks.measureProjectGroupHeaderDragRects).toHaveBeenCalledTimes(2)
  })
})
