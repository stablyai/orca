// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  resolveSpreadsheetResizeKeyStep,
  useSpreadsheetColumnResize,
  useSpreadsheetRowResize,
  useSpreadsheetSizeResize
} from './use-spreadsheet-resize'

describe('resolveSpreadsheetResizeKeyStep', () => {
  it('widens by one step on ArrowRight', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowRight', false)).toBe(8)
  })

  it('widens by a coarse step on shift ArrowRight', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowRight', true)).toBe(48)
  })

  it('narrows by one step on ArrowLeft', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowLeft', false)).toBe(-8)
  })

  it('narrows by a coarse step on shift ArrowLeft', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowLeft', true)).toBe(-48)
  })

  it('reports no step for a key it does not handle', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowUp', false)).toBe(null)
    expect(resolveSpreadsheetResizeKeyStep('Enter', false)).toBe(null)
    expect(resolveSpreadsheetResizeKeyStep('a', false)).toBe(null)
    expect(resolveSpreadsheetResizeKeyStep('', false)).toBe(null)
  })

  it('reports no step for an unhandled key even when coarse', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowDown', true)).toBe(null)
  })

  it('sizes a column with the horizontal arrows when told so explicitly', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowRight', false, 'vertical')).toBe(8)
    expect(resolveSpreadsheetResizeKeyStep('ArrowLeft', false, 'vertical')).toBe(-8)
  })

  it('leaves the vertical arrows alone on a column separator', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowDown', false, 'vertical')).toBe(null)
    expect(resolveSpreadsheetResizeKeyStep('ArrowUp', false, 'vertical')).toBe(null)
  })

  it('grows a row by one step on ArrowDown', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowDown', false, 'horizontal')).toBe(8)
  })

  it('grows a row by a coarse step on shift ArrowDown', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowDown', true, 'horizontal')).toBe(48)
  })

  it('shrinks a row by one step on ArrowUp', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowUp', false, 'horizontal')).toBe(-8)
  })

  it('shrinks a row by a coarse step on shift ArrowUp', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowUp', true, 'horizontal')).toBe(-48)
  })

  it('leaves the horizontal arrows alone on a row separator', () => {
    expect(resolveSpreadsheetResizeKeyStep('ArrowRight', false, 'horizontal')).toBe(null)
    expect(resolveSpreadsheetResizeKeyStep('ArrowLeft', true, 'horizontal')).toBe(null)
  })
})

describe('useSpreadsheetRowResize', () => {
  it('starts with no reader heights and no drag in progress', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(1))

    expect(result.current.widthOverrides).toEqual([])
    expect(result.current.resizingColumnIndex).toBe(null)
  })

  it('adds the pointer travel to the height the drag started from', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(1))

    act(() => result.current.startResize(2, 40))
    act(() => result.current.updateResize(20))

    expect(result.current.widthOverrides[2]).toBe(60)
  })

  it('clamps a drag past the top edge to the row minimum, tighter than a column', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(1))

    act(() => result.current.startResize(0, 40))
    act(() => result.current.updateResize(-500))

    expect(result.current.widthOverrides[0]).toBe(12)
  })

  it('clamps a runaway drag to the row maximum, lower than a column', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(1))

    act(() => result.current.startResize(0, 40))
    act(() => result.current.updateResize(9999))

    expect(result.current.widthOverrides[0]).toBe(400)
  })

  it('stores the height unzoomed so it keeps its proportion at other zoom levels', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(2))

    act(() => result.current.startResize(0, 80))
    act(() => result.current.updateResize(40))

    expect(result.current.widthOverrides[0]).toBe(60)
  })

  it('drops one row height so the row sizes itself again', () => {
    const { result } = renderHook(() => useSpreadsheetRowResize(1))

    act(() => result.current.nudgeResize(1, 40, 8))
    act(() => result.current.resetColumn(1))

    expect(result.current.widthOverrides[1]).toBe(undefined)
  })

  it('keeps row heights and column widths in separate state', () => {
    const rows = renderHook(() => useSpreadsheetRowResize(1))
    const columns = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => rows.result.current.nudgeResize(0, 40, 8))

    expect(rows.result.current.widthOverrides[0]).toBe(48)
    expect(columns.result.current.widthOverrides).toEqual([])
  })
})

describe('useSpreadsheetSizeResize', () => {
  it('clamps to the bounds it was handed rather than the column ones', () => {
    const { result } = renderHook(() => useSpreadsheetSizeResize(1, { minPx: 5, maxPx: 50 }))

    act(() => result.current.startResize(0, 20))
    act(() => result.current.updateResize(-500))
    expect(result.current.widthOverrides[0]).toBe(5)

    act(() => result.current.updateResize(9999))
    expect(result.current.widthOverrides[0]).toBe(50)
  })

  it('pins every drag to the single size allowed by equal bounds', () => {
    const { result } = renderHook(() => useSpreadsheetSizeResize(1, { minPx: 30, maxPx: 30 }))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(-40))
    expect(result.current.widthOverrides[0]).toBe(30)

    act(() => result.current.updateResize(40))
    expect(result.current.widthOverrides[0]).toBe(30)
  })
})

describe('useSpreadsheetColumnResize', () => {
  it('starts with no reader widths and no drag in progress', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    expect(result.current.widthOverrides).toEqual([])
    expect(result.current.resizingColumnIndex).toBe(null)
  })

  it('marks the dragged column without changing widths yet', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(2, 200))

    expect(result.current.resizingColumnIndex).toBe(2)
    expect(result.current.widthOverrides).toEqual([])
  })

  it('adds the pointer travel to the width the drag started from', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(2, 200))
    act(() => result.current.updateResize(50))

    expect(result.current.widthOverrides[2]).toBe(250)
  })

  it('stores the width unzoomed so it keeps its proportion at other zoom levels', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(2))

    act(() => result.current.startResize(0, 200))
    act(() => result.current.updateResize(100))

    expect(result.current.widthOverrides[0]).toBe(150)
  })

  it('ignores a drag update that no drag started', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.updateResize(50))

    expect(result.current.widthOverrides).toEqual([])
  })

  it('stops reacting to drag updates once the drag ends', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(20))
    act(() => result.current.endResize())
    act(() => result.current.updateResize(500))

    expect(result.current.resizingColumnIndex).toBe(null)
    expect(result.current.widthOverrides[0]).toBe(120)
  })

  it('clamps a drag past the left edge to the minimum width', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(-500))

    expect(result.current.widthOverrides[0]).toBe(24)
  })

  it('clamps a runaway drag to the maximum width', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(9999))

    expect(result.current.widthOverrides[0]).toBe(2000)
  })

  it('stores a whole number of pixels at a fractional zoom level', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1.3))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(10))

    expect(Number.isInteger(result.current.widthOverrides[0])).toBe(true)
  })

  it('treats a zoom scale of zero as no zoom', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(0))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(50))

    expect(result.current.widthOverrides[0]).toBe(150)
  })

  it('treats a negative zoom scale as no zoom', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(-2))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(50))

    expect(result.current.widthOverrides[0]).toBe(150)
  })

  it('nudges a column without a drag having started', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.nudgeResize(1, 100, 8))

    expect(result.current.widthOverrides[1]).toBe(108)
  })

  it('stores a nudge unzoomed', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(2))

    act(() => result.current.nudgeResize(1, 200, 8))

    expect(result.current.widthOverrides[1]).toBe(104)
  })

  it('clamps a nudge to the minimum width', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.nudgeResize(0, 26, -48))

    expect(result.current.widthOverrides[0]).toBe(24)
  })

  it('clamps a nudge to the maximum width', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.nudgeResize(0, 1990, 48))

    expect(result.current.widthOverrides[0]).toBe(2000)
  })

  it('drops one column width and leaves the others alone', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.nudgeResize(1, 100, 8))
    act(() => result.current.nudgeResize(2, 100, 8))
    act(() => result.current.resetColumn(2))

    expect(result.current.widthOverrides[1]).toBe(108)
    expect(result.current.widthOverrides[2]).toBe(undefined)
  })

  it('keeps the same widths array when resetting a column that has no width', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.nudgeResize(1, 100, 8))
    const before = result.current.widthOverrides
    act(() => result.current.resetColumn(4))

    expect(result.current.widthOverrides).toBe(before)
  })

  it('sizes columns independently, leaving the untouched ones empty', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(10))
    act(() => result.current.endResize())
    act(() => result.current.startResize(5, 200))
    act(() => result.current.updateResize(20))
    act(() => result.current.endResize())

    expect(result.current.widthOverrides[0]).toBe(110)
    expect(result.current.widthOverrides[5]).toBe(220)
    expect(result.current.widthOverrides.slice(1, 5)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined
    ])
  })

  it('measures each drag update from the width the drag started at', () => {
    const { result } = renderHook(() => useSpreadsheetColumnResize(1))

    act(() => result.current.startResize(0, 100))
    act(() => result.current.updateResize(10))
    expect(result.current.widthOverrides[0]).toBe(110)

    act(() => result.current.updateResize(20))
    expect(result.current.widthOverrides[0]).toBe(120)
  })
})
