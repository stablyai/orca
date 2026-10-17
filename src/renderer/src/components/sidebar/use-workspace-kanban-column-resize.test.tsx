// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceKanbanColumnResize } from './use-workspace-kanban-column-resize'

let viewportWidth = 1636
let notifyResize = () => {}
let preference = 308
const commit = vi.fn()

function Columns({ expand = true, count = 4, open = true }) {
  const result = useWorkspaceKanbanColumnResize(
    preference,
    (width) => {
      preference = width
      commit(width)
    },
    { expand, open, columnCount: count, columnGap: 12 }
  )
  return (
    <div ref={result.measureLaneScroller}>
      <button
        type="button"
        data-width={result.columnWidth}
        data-max={result.columnWidthMax}
        onPointerDown={result.onColumnResizeStart}
        onKeyDown={result.onColumnResizeKeyDown}
      >
        Resize columns
      </button>
    </div>
  )
}

const width = () => Number(screen.getByRole('button').getAttribute('data-width'))

function resizeViewport(width: number): void {
  viewportWidth = width
  act(() => notifyResize())
}

beforeEach(() => {
  viewportWidth = 1636
  preference = 308
  commit.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => new DOMRect(0, 0, viewportWidth, 400)
  )
  vi.stubGlobal(
    'ResizeObserver',
    class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = () => callback([], this)
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('fits the viewport and status counts without changing the saved width', () => {
  const view = render(<Columns />)
  expect(width()).toBe(400)
  resizeViewport(1836)
  expect(width()).toBe(450)
  resizeViewport(1000)
  expect(width()).toBe(308)
  resizeViewport(1636)
  view.rerender(<Columns expand={false} />)
  expect(width()).toBe(308)
  view.rerender(<Columns count={0} />)
  expect(width()).toBe(308)
  view.rerender(<Columns count={20} />)
  expect(width()).toBe(308)
  expect(commit).not.toHaveBeenCalled()
})

it.each([
  { count: 4, displayed: 400, manual: 380, saved: 380, reopened: 450 },
  { count: 2, displayed: 812, manual: 792, saved: 520, reopened: 912 }
])(
  'resizes $count columns from their displayed width until closing',
  ({ count, displayed, manual, saved, reopened }) => {
    const view = render(<Columns count={count} />)
    const handle = screen.getByRole('button')
    expect(width()).toBe(displayed)
    expect(Number(handle.getAttribute('data-max'))).toBeGreaterThanOrEqual(displayed)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(width()).toBe(manual)
    expect(commit).toHaveBeenLastCalledWith(saved)
    resizeViewport(1836)
    expect(width()).toBe(manual)
    view.rerender(<Columns count={count} open={false} />)
    view.rerender(<Columns count={count} />)
    expect(width()).toBe(reopened)
    resizeViewport(1000)
    view.rerender(<Columns count={count} open={false} />)
    view.rerender(<Columns count={count} />)
    expect(width()).toBe(saved)
  }
)

it('ignores no-op clicks and starts pointer resizing at the displayed width', () => {
  render(<Columns />)
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
  fireEvent.pointerMove(window, { clientX: 500 })
  fireEvent.pointerUp(window)
  expect(commit).not.toHaveBeenCalled()
  resizeViewport(1836)
  expect(width()).toBe(450)
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
  fireEvent.pointerMove(window, { clientX: 470 })
  fireEvent.pointerUp(window)
  expect(width()).toBe(420)
  expect(commit).toHaveBeenLastCalledWith(420)
  resizeViewport(2000)
  expect(width()).toBe(420)
})

it.each(
  [
    { viewport: 1636, count: 4, displayed: 400, dragged: 370, resized: 450 },
    { viewport: 1636, count: 2, displayed: 812, dragged: 782, resized: 912 },
    { viewport: 1636.5, count: 2, displayed: 812.25, dragged: 782, resized: 912.25 },
    { viewport: 1636, count: 3, displayed: 537.3333333333334, dragged: 507, resized: 604 }
  ].flatMap((layout) => [false, true].map((preview) => ({ ...layout, preview })))
)(
  'keeps automatic sizing after an out-and-back drag at $displayed px (preview: $preview)',
  ({ viewport, count, displayed, dragged, resized, preview }) => {
    let flushFrame = () => {}
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      flushFrame = () => callback(performance.now())
      return 1
    })
    viewportWidth = viewport
    const view = render(<Columns count={count} />)
    expect(width()).toBe(displayed)
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
    fireEvent.pointerMove(window, { clientX: 470 })
    if (preview) {
      act(() => flushFrame())
      expect(width()).toBe(dragged)
    }
    fireEvent.pointerMove(window, { clientX: 500 })
    if (preview) {
      act(() => flushFrame())
    }
    fireEvent.pointerUp(window)
    expect(width()).toBe(displayed)
    expect(preference).toBe(308)
    expect(commit).not.toHaveBeenCalled()
    expect(document.body.style.cursor).toBe('')
    resizeViewport(viewport + 200)
    expect(width()).toBe(resized)
    view.rerender(<Columns count={count} expand={false} />)
    expect(width()).toBe(308)
  }
)

it('keeps an existing manual choice after an out-and-back drag', () => {
  let flushFrame = () => {}
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    flushFrame = () => callback(performance.now())
    return 1
  })
  const view = render(<Columns count={2} />)
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowLeft' })
  expect(width()).toBe(792)
  expect(preference).toBe(520)
  commit.mockClear()
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
  fireEvent.pointerMove(window, { clientX: 470 })
  act(() => flushFrame())
  expect(width()).toBe(762)
  fireEvent.pointerMove(window, { clientX: 500 })
  act(() => flushFrame())
  fireEvent.pointerUp(window)
  expect(width()).toBe(792)
  expect(preference).toBe(520)
  expect(commit).not.toHaveBeenCalled()
  resizeViewport(1836)
  expect(width()).toBe(792)
  view.rerender(<Columns count={2} expand={false} />)
  expect(width()).toBe(520)
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
  fireEvent.pointerMove(window, { clientX: 470 })
  act(() => flushFrame())
  fireEvent.pointerMove(window, { clientX: 500 })
  act(() => flushFrame())
  fireEvent.pointerUp(window)
  expect(width()).toBe(520)
  view.rerender(<Columns count={2} />)
  expect(width()).toBe(792)
})

it('discards an uncommitted pointer draft when closed and reopened with the sidebar visible', () => {
  let flushFrame = () => {}
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    flushFrame = () => callback(performance.now())
    return 1
  })
  const view = render(<Columns />)
  fireEvent.pointerDown(screen.getByRole('button'), { button: 0, clientX: 500 })
  fireEvent.pointerMove(window, { clientX: 470 })
  act(() => flushFrame())
  expect(width()).toBe(370)
  view.rerender(<Columns expand={false} open={false} />)
  view.rerender(<Columns expand={false} />)
  expect(width()).toBe(308)
  expect(document.body.style.cursor).toBe('')
  expect(commit).not.toHaveBeenCalled()
})

it('preserves manual width limits and reflects external saved preferences', () => {
  preference = 220
  const view = render(<Columns expand={false} />)
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowLeft' })
  expect(width()).toBe(220)
  preference = 520
  view.rerender(<Columns expand={false} />)
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowRight' })
  expect(width()).toBe(520)
  preference = 400
  view.rerender(<Columns expand={false} />)
  fireEvent.keyDown(screen.getByRole('button'), { key: 'ArrowLeft', shiftKey: true })
  expect(width()).toBe(360)
  expect(commit).toHaveBeenLastCalledWith(360)
})
