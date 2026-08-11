// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import { isRepoHeaderActionTarget, useRepoHeaderDrag } from './project-header-drag'
import type { RepoDragState } from './project-header-drag-contract'
import type { Repo } from '../../../../shared/types'

function createHeader(markup: string): HTMLElement {
  const header = document.createElement('div')
  header.setAttribute('data-repo-header-id', 'repo-1')
  header.innerHTML = markup
  document.body.appendChild(header)
  return header
}

describe('repo header action targets', () => {
  it('ignores explicit project action wrappers', () => {
    const header = createHeader(`
      <span data-repo-header-action="" tabindex="0">
        <span id="icon"></span>
      </span>
    `)

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('ignores native nested controls', () => {
    const header = createHeader('<button type="button"><span id="icon"></span></button>')

    expect(isRepoHeaderActionTarget(header.querySelector('#icon'), header)).toBe(true)
  })

  it('does not ignore plain header text or the header itself', () => {
    const header = createHeader('<span id="label">Orca</span>')

    expect(isRepoHeaderActionTarget(header.querySelector('#label'), header)).toBe(false)
    expect(isRepoHeaderActionTarget(header, header)).toBe(false)
  })

  it('ignores the hover collapse affordance', () => {
    const header = createHeader(`
      <div data-repo-header-collapse-affordance="">
        <span id="chevron"></span>
      </div>
    `)

    expect(isRepoHeaderActionTarget(header.querySelector('#chevron'), header)).toBe(true)
  })
})

// React's act() warns unless the environment opts in, and the global is untyped.
const reactActGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
reactActGlobal.IS_REACT_ACT_ENVIRONMENT = true

const POINTER_ID = 7
const HEADER_HEIGHT = 28
const SCROLL_CONTENT_HEIGHT = 200
const HEADER_IDS = ['repo-1', 'repo-2']
// Lands in the lower half of repo-2's band, so the drop index moves repo-1 last.
const DRAG_POINTER_Y = 50
const MID_DRAG_SCROLL_PX = 20

let latestState: RepoDragState

function makeRepo(id: string): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0 } as Repo
}

const REPO_BY_ID: ReadonlyMap<string, Repo> = new Map(HEADER_IDS.map((id) => [id, makeRepo(id)]))

function Harness({ onCommitRepoOrder }: { onCommitRepoOrder: (ids: string[]) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const controller = useRepoHeaderDrag({
    orderedRepoIds: [...HEADER_IDS],
    sidebarRepoHeaderIdsByBucket: new Map([['ungrouped', HEADER_IDS]]),
    repoById: REPO_BY_ID,
    usesProjectGroupOrdering: false,
    onCommitRepoOrder,
    onCommitProjectGroupOrder: () => {},
    getScrollContainer: () => scrollRef.current
  })
  latestState = controller.state
  return (
    <div ref={scrollRef}>
      {HEADER_IDS.map((repoId, index) => (
        <div
          key={repoId}
          data-repo-header-id={repoId}
          data-repo-header-bucket="ungrouped"
          data-repo-header-index={index}
          // The drag-handle attribute is required — isProjectHeaderDragHandleTarget
          // rejects a pointerdown that does not land inside one.
          data-repo-header-drag-handle=""
          onPointerDown={(event) => controller.onHandlePointerDown(event, repoId)}
        />
      ))}
    </div>
  )
}

function makeRect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({})
  } as DOMRect
}

// Why: happy-dom reports zero-sized boxes, so without stubbed geometry every
// drop preview falls outside the measured content and the drag is a no-op.
function stubHeaderLayout(container: HTMLElement): void {
  const scrollEl = container.firstElementChild as HTMLElement
  Object.defineProperty(scrollEl, 'scrollHeight', {
    value: SCROLL_CONTENT_HEIGHT,
    configurable: true
  })
  scrollEl.getBoundingClientRect = () => makeRect(0, SCROLL_CONTENT_HEIGHT)
  // Why: happy-dom clamps scrollTop against a zero client height, so a mid-drag
  // scroll needs a plain writable stand-in to be observable at all.
  Object.defineProperty(scrollEl, 'scrollTop', { value: 0, writable: true, configurable: true })
  scrollEl.querySelectorAll<HTMLElement>('[data-repo-header-id]').forEach((element, index) => {
    element.getBoundingClientRect = () => makeRect(index * HEADER_HEIGHT, HEADER_HEIGHT)
  })
}

function mountHarness(onCommitRepoOrder: (ids: string[]) => void = () => {}): {
  root: Root
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => root.render(<Harness onCommitRepoOrder={onCommitRepoOrder} />))
  stubHeaderLayout(container)
  return { root, container }
}

function startPromotedDrag(container: HTMLElement): void {
  const handle = container.querySelector('[data-repo-header-drag-handle]')!
  act(() => {
    handle.dispatchEvent(
      new PointerEvent('pointerdown', { pointerId: POINTER_ID, clientY: 0, bubbles: true })
    )
  })
  // Cross the 4px promotion threshold.
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y })
    )
  })
}

describe('project header drag cancellation', () => {
  // Why: separate cases rather than one shared assertion — a header stranded in
  // its lifted state is the worst user-visible failure, so each exit path gets
  // its own gate.
  const CANCELS: [string, () => void][] = [
    ['Escape', () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    [
      'pointercancel',
      () => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: POINTER_ID }))
    ],
    ['window blur', () => window.dispatchEvent(new Event('blur'))]
  ]

  it.each(CANCELS)('clears the drag state when the drag ends via %s', (_label, cancel) => {
    const { root, container } = mountHarness()
    startPromotedDrag(container)
    expect(latestState.draggingRepoId).toBe('repo-1')
    expect(latestState.previewOffsetsByRepoId.get('repo-2')).toBe(-HEADER_HEIGHT)

    act(() => cancel())

    expect(latestState.draggingRepoId).toBeNull()
    expect(latestState.pointerOffsetY).toBeNull()
    expect(latestState.previewOffsetsByRepoId.size).toBe(0)
    act(() => root.unmount())
  })
})

describe('project header drag preview offsets', () => {
  it('keeps the same state object when a pointer frame changes nothing', () => {
    const { root, container } = mountHarness()
    startPromotedDrag(container)
    // Guards against a vacuous pass: if a future change made the drop preview
    // null for the whole drag, the identity check below would hold trivially.
    expect(latestState.previewOffsetsByRepoId.size).toBe(1)
    const stateBeforeIdleMove = latestState

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y })
      )
    })

    // Offsets are rebuilt into a fresh Map every frame, so an identity check
    // here would re-render the whole sidebar for the duration of the drag.
    expect(latestState).toBe(stateBeforeIdleMove)
    act(() => root.unmount())
  })
})

describe('project header drag pointer offset', () => {
  it('is null before promotion, tracks the pointer, and clears when the drag ends', () => {
    vi.useFakeTimers()
    const { root, container } = mountHarness()
    const handle = container.querySelector('[data-repo-header-drag-handle]')!
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: POINTER_ID, clientY: 0, bubbles: true })
      )
    })
    // Below the 4px threshold, so the drag is armed but not promoted.
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: 2 }))
    })
    expect(latestState.draggingRepoId).toBeNull()
    expect(latestState.pointerOffsetY).toBeNull()

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y })
      )
    })
    expect(latestState.draggingRepoId).toBe('repo-1')
    expect(latestState.pointerOffsetY).toBe(DRAG_POINTER_Y)

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y + 6 })
      )
    })
    expect(latestState.pointerOffsetY).toBe(DRAG_POINTER_Y + 6)

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y + 6 })
      )
    })
    expect(latestState.settling).toBe(true)
    act(() => vi.advanceTimersByTime(150))
    expect(latestState.pointerOffsetY).toBeNull()
    act(() => root.unmount())
    vi.useRealTimers()
  })
})

describe('project header drag pointer offset across a scroll', () => {
  it('keeps the lifted header under the pointer when the list scrolls mid-drag', () => {
    const { root, container } = mountHarness()
    const scrollEl = container.firstElementChild as HTMLElement
    startPromotedDrag(container)
    expect(latestState.pointerOffsetY).toBe(DRAG_POINTER_Y)

    act(() => {
      scrollEl.scrollTop = MID_DRAG_SCROLL_PX
      window.dispatchEvent(
        new PointerEvent('pointermove', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y })
      )
    })

    // The offset is composed into a content-space transform, so with the pointer
    // parked it must grow by the scroll distance; a viewport-space delta would
    // stay put here and slide the header off the cursor by that same distance.
    expect(latestState.pointerOffsetY).toBe(DRAG_POINTER_Y + MID_DRAG_SCROLL_PX)
    expect((latestState.pointerOffsetY ?? 0) - scrollEl.scrollTop).toBe(DRAG_POINTER_Y)
    act(() => root.unmount())
  })
})

describe('project header drag commit', () => {
  it('still commits a reorder on pointerup', () => {
    vi.useFakeTimers()
    const onCommitRepoOrder = vi.fn()
    const { root, container } = mountHarness(onCommitRepoOrder)
    startPromotedDrag(container)

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointerup', { pointerId: POINTER_ID, clientY: DRAG_POINTER_Y })
      )
    })

    expect(latestState.settling).toBe(true)
    expect(onCommitRepoOrder).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(150))

    // The visual settles into the placeholder before the persisted reorder.
    expect(onCommitRepoOrder).toHaveBeenCalledExactlyOnceWith(['repo-2', 'repo-1'])
    expect(latestState.draggingRepoId).toBeNull()
    expect(latestState.pointerOffsetY).toBeNull()
    expect(latestState.previewOffsetsByRepoId.size).toBe(0)
    act(() => root.unmount())
    vi.useRealTimers()
  })
})
