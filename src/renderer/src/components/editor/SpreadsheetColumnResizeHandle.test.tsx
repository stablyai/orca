// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpreadsheetColumnResizeHandle } from './SpreadsheetColumnResizeHandle'
import type { SpreadsheetColumnResize } from './use-spreadsheet-column-resize'

type ResizeDouble = {
  [Key in keyof SpreadsheetColumnResize]: SpreadsheetColumnResize[Key] extends (
    ...args: never[]
  ) => unknown
    ? ReturnType<typeof vi.fn>
    : SpreadsheetColumnResize[Key]
}

const capturedPointerIds = new Set<number>()

function createResizeDouble(resizingColumnIndex: number | null = null): ResizeDouble {
  return {
    widthOverrides: [],
    startResize: vi.fn(),
    updateResize: vi.fn(),
    endResize: vi.fn(),
    nudgeResize: vi.fn(),
    resetColumn: vi.fn(),
    resizingColumnIndex
  }
}

function renderHandle(resize: ResizeDouble): HTMLElement {
  render(
    <SpreadsheetColumnResizeHandle
      columnIndex={3}
      renderedWidthPx={120}
      resize={resize as unknown as SpreadsheetColumnResize}
      label="D"
    />
  )
  return screen.getByRole('separator')
}

beforeEach(() => {
  capturedPointerIds.clear()
  Object.assign(HTMLElement.prototype, {
    setPointerCapture: vi.fn((pointerId: number) => {
      capturedPointerIds.add(pointerId)
    }),
    hasPointerCapture: vi.fn((pointerId: number) => capturedPointerIds.has(pointerId)),
    releasePointerCapture: vi.fn((pointerId: number) => {
      capturedPointerIds.delete(pointerId)
    })
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
  Reflect.deleteProperty(HTMLElement.prototype, 'hasPointerCapture')
  Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture')
  vi.restoreAllMocks()
})

describe('SpreadsheetColumnResizeHandle', () => {
  it('announces itself as a vertical separator naming its column', () => {
    const handle = renderHandle(createResizeDouble())

    expect(handle.getAttribute('aria-orientation')).toBe('vertical')
    expect(handle.getAttribute('aria-label')).toContain('D')
  })

  it('is reachable with the keyboard', () => {
    const handle = renderHandle(createResizeDouble())

    expect(handle.tabIndex).toBe(0)
  })

  it('starts a drag on the column and width it was given', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })

    expect(resize.startResize).toHaveBeenCalledWith(3, 120)
  })

  it('captures the pointer so the drag survives leaving the grip', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })

    expect(handle.setPointerCapture).toHaveBeenCalledWith(7)
  })

  it('reports the travel from where the drag began', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 160 })

    expect(resize.updateResize).toHaveBeenCalledWith(60)
  })

  it('keeps measuring later moves from the drag start rather than the previous move', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 160 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 180 })

    expect(resize.updateResize).toHaveBeenLastCalledWith(80)
  })

  it('ignores a move while no column is being dragged', () => {
    const resize = createResizeDouble(null)
    const handle = renderHandle(resize)

    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 160 })

    expect(resize.updateResize).not.toHaveBeenCalled()
  })

  it('ignores a move while another column is being dragged', () => {
    const resize = createResizeDouble(1)
    const handle = renderHandle(resize)

    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 160 })

    expect(resize.updateResize).not.toHaveBeenCalled()
  })

  it('ends the drag and releases the pointer on pointer up', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 160 })

    expect(resize.endResize).toHaveBeenCalledTimes(1)
    expect(handle.releasePointerCapture).toHaveBeenCalledWith(7)
  })

  it('ends the drag when the pointer is cancelled', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 100 })
    fireEvent.pointerCancel(handle, { pointerId: 7, clientX: 160 })

    expect(resize.endResize).toHaveBeenCalledTimes(1)
  })

  it('drops the column width on a double click', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.doubleClick(handle)

    expect(resize.resetColumn).toHaveBeenCalledWith(3)
  })

  it('widens the column by one step on ArrowRight', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(resize.nudgeResize).toHaveBeenCalledWith(3, 120, 8)
  })

  it('widens the column by a coarse step on shift ArrowRight', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true })

    expect(resize.nudgeResize).toHaveBeenCalledWith(3, 120, 48)
  })

  it('narrows the column on ArrowLeft', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })

    expect(resize.nudgeResize).toHaveBeenCalledWith(3, 120, -8)
  })

  it('drops the column width on Enter', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'Enter' })

    expect(resize.resetColumn).toHaveBeenCalledWith(3)
  })

  it('drops the column width on Backspace', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'Backspace' })

    expect(resize.resetColumn).toHaveBeenCalledWith(3)
  })

  it('leaves a key it does not handle alone', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize)

    fireEvent.keyDown(handle, { key: 'a' })

    expect(resize.nudgeResize).not.toHaveBeenCalled()
    expect(resize.resetColumn).not.toHaveBeenCalled()
  })

  it('swallows ArrowRight so the grid does not scroll as well', () => {
    const handle = renderHandle(createResizeDouble())

    const defaultAllowed = fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(defaultAllowed).toBe(false)
  })

  it('marks itself active while its own column is being dragged', () => {
    const handle = renderHandle(createResizeDouble(3))

    expect(handle.classList.contains('bg-spreadsheet-gridline-strong')).toBe(true)
  })

  it('stays unmarked while another column is being dragged', () => {
    const handle = renderHandle(createResizeDouble(1))

    expect(handle.classList.contains('bg-spreadsheet-gridline-strong')).toBe(false)
  })
})
