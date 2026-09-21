// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_STORAGE_PREFIX, useAgentCanvasDocument } from './use-agent-canvas-document'

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('canvas persistence', () => {
  it('persists a remote launch that finishes after the canvas was unmounted', () => {
    const view = renderHook(() => useAgentCanvasDocument('background-launch'))
    const update = view.result.current.update
    view.unmount()
    act(() => update((value) => ({ ...value, viewport: { x: 123, y: 0, zoom: 1 } })))
    const restored = renderHook(() => useAgentCanvasDocument('background-launch'))
    expect(restored.result.current.document.viewport.x).toBe(123)
  })
  it('flushes an unsaved edit on unmount and restores it without crossing project scope', () => {
    const first = renderHook(() => useAgentCanvasDocument('project-a'))
    act(() =>
      first.result.current.update((value) => ({
        ...value,
        nodes: [
          {
            id: 'note',
            kind: 'note',
            position: { x: 200, y: 60 },
            width: 320,
            height: 240,
            title: 'Plan',
            content: 'Review the API'
          }
        ]
      }))
    )
    first.unmount()
    const restored = renderHook(() => useAgentCanvasDocument('project-a'))
    const other = renderHook(() => useAgentCanvasDocument('project-b'))
    expect(restored.result.current.document.nodes[0].content).toBe('Review the API')
    expect(other.result.current.document.nodes).toEqual([])
  })
  it('preserves unreadable saved data and refuses edits', () => {
    const key = `${CANVAS_STORAGE_PREFIX}future`
    const saved = '{"version":999}'
    localStorage.setItem(key, saved)
    const view = renderHook(() => useAgentCanvasDocument('future'))
    act(() => {
      view.result.current.update((value) => ({ ...value, viewport: { x: 42, y: 42, zoom: 1 } }))
      vi.runAllTimers()
    })
    expect(view.result.current.readOnly).toBe(true)
    expect(view.result.current.error).toBeTruthy()
    expect(localStorage.getItem(key)).toBe(saved)
  })
  it('reports failed persistence and allows retry without losing the current edit', () => {
    const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })
    const view = renderHook(() => useAgentCanvasDocument('quota'))
    act(() => {
      view.result.current.update((value) => ({ ...value, viewport: { x: 200, y: 60, zoom: 0.5 } }))
    })
    act(() => vi.advanceTimersByTime(400))
    expect(view.result.current.error).toContain('could not be saved')
    write.mockRestore()
    act(() => view.result.current.save())
    expect(view.result.current.error).toBeNull()
    expect(JSON.parse(localStorage.getItem(`${CANVAS_STORAGE_PREFIX}quota`)!).viewport.x).toBe(200)
  })
  it('undoes an entire drag checkpoint and persists the restored position', () => {
    const view = renderHook(() => useAgentCanvasDocument('undo'))
    act(() => view.result.current.checkpoint())
    act(() =>
      view.result.current.update(
        (value) => ({ ...value, viewport: { x: 500, y: 200, zoom: 1 } }),
        false
      )
    )
    act(() => view.result.current.undo())
    expect(view.result.current.document.viewport.x).toBe(40)
  })
})
