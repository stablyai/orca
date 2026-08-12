// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpreadsheetResizeHandle } from './SpreadsheetResizeHandle'
import type { SpreadsheetColumnResize } from './use-spreadsheet-resize'

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

function renderHandle(
  resize: ResizeDouble,
  orientation: 'vertical' | 'horizontal' = 'vertical'
): HTMLElement {
  render(
    <SpreadsheetResizeHandle
      index={3}
      renderedSizePx={120}
      resize={resize as unknown as SpreadsheetColumnResize}
      label="D"
      orientation={orientation}
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

describe('SpreadsheetResizeHandle', () => {
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

  it('names the column it sizes when vertical', () => {
    const handle = renderHandle(createResizeDouble())

    expect(handle.getAttribute('aria-label')).toContain('Resize column')
  })

  it('grips the bottom edge with a row cursor when horizontal', () => {
    const handle = renderHandle(createResizeDouble(), 'horizontal')

    expect(handle.classList.contains('cursor-row-resize')).toBe(true)
    expect(handle.classList.contains('h-[6px]')).toBe(true)
  })

  it('grips the trailing edge with a column cursor when vertical', () => {
    const handle = renderHandle(createResizeDouble())

    expect(handle.classList.contains('cursor-col-resize')).toBe(true)
    expect(handle.classList.contains('w-[6px]')).toBe(true)
  })
})

describe('SpreadsheetResizeHandle on a row', () => {
  it('announces itself as a horizontal separator naming its row', () => {
    const handle = renderHandle(createResizeDouble(), 'horizontal')

    expect(handle.getAttribute('aria-orientation')).toBe('horizontal')
    expect(handle.getAttribute('aria-label')).toContain('Resize row')
  })

  it('reports the vertical travel and ignores how far the pointer strayed sideways', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 10, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400, clientY: 160 })

    expect(resize.updateResize).toHaveBeenCalledWith(60)
  })

  it('reads the horizontal travel on a column separator given the same crossed move', () => {
    const resize = createResizeDouble(3)
    const handle = renderHandle(resize)

    fireEvent.pointerDown(handle, { pointerId: 7, clientX: 10, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400, clientY: 160 })

    expect(resize.updateResize).toHaveBeenCalledWith(390)
  })

  it('grows the row by one step on ArrowDown', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.keyDown(handle, { key: 'ArrowDown' })

    expect(resize.nudgeResize).toHaveBeenCalledWith(3, 120, 8)
  })

  it('shrinks the row on ArrowUp', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.keyDown(handle, { key: 'ArrowUp' })

    expect(resize.nudgeResize).toHaveBeenCalledWith(3, 120, -8)
  })

  it('leaves ArrowRight alone on a row separator', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })

    expect(resize.nudgeResize).not.toHaveBeenCalled()
    expect(resize.resetColumn).not.toHaveBeenCalled()
  })

  it('drops the row height on a double click', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.doubleClick(handle)

    expect(resize.resetColumn).toHaveBeenCalledWith(3)
  })

  it('drops the row height on Enter and on Backspace', () => {
    const resize = createResizeDouble()
    const handle = renderHandle(resize, 'horizontal')

    fireEvent.keyDown(handle, { key: 'Enter' })
    fireEvent.keyDown(handle, { key: 'Backspace' })

    expect(resize.resetColumn).toHaveBeenCalledTimes(2)
    expect(resize.resetColumn).toHaveBeenLastCalledWith(3)
  })
})
