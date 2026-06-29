// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  isGroupHeaderActionTarget,
  isGroupHeaderDragHandleTarget,
  useGroupHeaderDrag
} from './group-header-drag'
import type { GroupDragState } from './group-header-drag-contract'
import type { ProjectGroup } from '../../../../shared/types'

// ---------------------------------------------------------------------------
// Predicate tests (mirror project-header-drag.test.ts structure)
// ---------------------------------------------------------------------------

function createHeader(markup: string): HTMLElement {
  const header = document.createElement('div')
  header.setAttribute('data-project-group-header-id', 'group-1')
  header.innerHTML = markup
  document.body.appendChild(header)
  return header
}

describe('group header action targets', () => {
  it('ignores explicit group action wrappers', () => {
    const header = createHeader(`
      <span data-repo-header-action="" tabindex="0">
        <span id="icon"></span>
      </span>
    `)

    expect(isGroupHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores native nested controls', () => {
    const header = createHeader('<button type="button"><span id="icon"></span></button>')

    expect(isGroupHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('does not ignore plain header text or the header itself', () => {
    const header = createHeader('<span id="label">My Group</span>')

    expect(isGroupHeaderActionTarget(header.querySelector('#label'), header)).toBe(false)
    expect(isGroupHeaderActionTarget(header, header)).toBe(false)
  })

  it('ignores the hover collapse affordance', () => {
    const header = createHeader(`
      <div data-repo-header-collapse-affordance="">
        <span id="chevron"></span>
      </div>
    `)

    expect(isGroupHeaderActionTarget(header.querySelector('#chevron'), header)).toBe(true)
  })
})

describe('group header drag handle targets', () => {
  it('returns true when the target is inside a drag handle', () => {
    const header = createHeader(`
      <div data-group-header-drag-handle="">
        <span id="icon"></span>
      </div>
    `)

    expect(isGroupHeaderDragHandleTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('returns false when the target is outside a drag handle', () => {
    const header = createHeader('<span id="label">Group Name</span>')

    expect(isGroupHeaderDragHandleTarget(header.querySelector('#label'), header)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle test — drive a full drag through the generic hook
// ---------------------------------------------------------------------------

function makeGroup(
  id: string,
  tabOrder: number,
  parentGroupId: string | null = null
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

/** A minimal component that mounts useGroupHeaderDrag and exposes state via ref. */
function HookProbe(props: {
  groupsById: ReadonlyMap<string, ProjectGroup>
  siblingGroupIdsByParent: ReadonlyMap<string | null, readonly string[]>
  onCommitGroupOrder: (groupId: string, tabOrder: number) => void
  getScrollContainer: () => HTMLElement | null
  stateRef: { current: GroupDragState }
  onHandlePointerDownRef: {
    current: ((event: React.PointerEvent<HTMLElement>, groupId: string) => void) | null
  }
}): null {
  const controller = useGroupHeaderDrag({
    groupsById: props.groupsById,
    siblingGroupIdsByParent: props.siblingGroupIdsByParent,
    onCommitGroupOrder: props.onCommitGroupOrder,
    getScrollContainer: props.getScrollContainer
  })
  props.stateRef.current = controller.state
  props.onHandlePointerDownRef.current = controller.onHandlePointerDown
  return null
}

describe('useGroupHeaderDrag lifecycle', () => {
  const roots: Root[] = []

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => {
        root.unmount()
      })
    }
    roots.length = 0
    document.body.innerHTML = ''
  })

  it('calls onCommitGroupOrder after a drag past the threshold over a sibling', async () => {
    const onCommitGroupOrder = vi.fn<(groupId: string, tabOrder: number) => void>()

    // Build two groups: group-a (tabOrder=0, siblingIndex=0), group-b (tabOrder=1, siblingIndex=1)
    const groupA = makeGroup('group-a', 0)
    const groupB = makeGroup('group-b', 1)
    const groupsById = new Map<string, ProjectGroup>([
      ['group-a', groupA],
      ['group-b', groupB]
    ])
    const siblingGroupIdsByParent = new Map<string | null, readonly string[]>([
      [null, ['group-a', 'group-b']]
    ])

    // Build a scroll container with two group header elements
    const container = document.createElement('div')
    Object.defineProperty(container, 'getBoundingClientRect', {
      value: () => ({ top: 0, left: 0, right: 300, bottom: 200, width: 300, height: 200 })
    })
    Object.defineProperty(container, 'scrollTop', { value: 0, writable: true })

    // Header A: y=0..40, siblingIndex=0
    const headerA = document.createElement('div')
    headerA.setAttribute('data-project-group-header-id', 'group-a')
    headerA.setAttribute('data-project-group-sibling-index', '0')
    headerA.setAttribute('data-project-group-parent', '')
    const handleA = document.createElement('div')
    handleA.setAttribute('data-group-header-drag-handle', '')
    headerA.appendChild(handleA)
    Object.defineProperty(headerA, 'getBoundingClientRect', {
      value: () => ({ top: 0, left: 0, right: 300, bottom: 40, width: 300, height: 40 })
    })
    Object.defineProperty(headerA, 'isConnected', { get: () => true })
    headerA.setPointerCapture = vi.fn()
    headerA.releasePointerCapture = vi.fn()

    // Header B: y=44..84, siblingIndex=1
    const headerB = document.createElement('div')
    headerB.setAttribute('data-project-group-header-id', 'group-b')
    headerB.setAttribute('data-project-group-sibling-index', '1')
    headerB.setAttribute('data-project-group-parent', '')
    Object.defineProperty(headerB, 'getBoundingClientRect', {
      value: () => ({ top: 44, left: 0, right: 300, bottom: 84, width: 300, height: 40 })
    })

    container.appendChild(headerA)
    container.appendChild(headerB)

    // querySelectorAll mock so measureGroupHeaderDragRects finds elements
    const origQSA = container.querySelectorAll.bind(container)
    container.querySelectorAll = (<K extends string>(sel: K) => {
      if (sel === '[data-project-group-header-id]') {
        return [headerA, headerB] as unknown as NodeListOf<Element>
      }
      return origQSA(sel)
    }) as typeof container.querySelectorAll

    document.body.appendChild(container)

    const stateRef: { current: GroupDragState } = {
      current: { draggingGroupId: null, dropIndex: null, dropIndicatorY: null }
    }
    const onHandlePointerDownRef: {
      current: ((event: React.PointerEvent<HTMLElement>, groupId: string) => void) | null
    } = { current: null }

    // Mount the hook
    const hookContainer = document.createElement('div')
    document.body.appendChild(hookContainer)
    const root = createRoot(hookContainer)
    roots.push(root)

    await act(async () => {
      root.render(
        createElement(HookProbe, {
          groupsById,
          siblingGroupIdsByParent,
          onCommitGroupOrder,
          getScrollContainer: () => container,
          stateRef,
          onHandlePointerDownRef
        })
      )
    })

    // Simulate pointerdown on the handle of group-a (currentTarget = handleA)
    const pointerDownEvent = {
      button: 0,
      pointerId: 1,
      clientX: 10,
      clientY: 20,
      target: handleA,
      currentTarget: handleA
    } as unknown as React.PointerEvent<HTMLElement>

    await act(async () => {
      onHandlePointerDownRef.current!(pointerDownEvent, 'group-a')
    })

    // Move past the 4px threshold to promote the session
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 25, bubbles: true })
      )
    })

    // Move pointer over the second group header (clientY=64 = middle of headerB)
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: 1, clientX: 10, clientY: 64, bubbles: true })
      )
    })

    // Pointer up to commit
    await act(async () => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: 1, clientX: 10, clientY: 64, bubbles: true })
      )
    })

    expect(onCommitGroupOrder).toHaveBeenCalledOnce()
    const [calledGroupId, calledTabOrder] = onCommitGroupOrder.mock.calls[0]!
    expect(calledGroupId).toBe('group-a')
    expect(Number.isFinite(calledTabOrder)).toBe(true)
  })
})
