// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  resolveSpreadsheetResizeKeyStep,
  useSpreadsheetColumnResize
} from './use-spreadsheet-column-resize'

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
