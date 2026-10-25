// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useFileExplorerSelection } from './useFileExplorerSelection'
import { createFileExplorerRowProjection } from './file-explorer-row-projection'
import { applyFileExplorerNavigation } from './file-explorer-keyboard-navigation'
import type { FileExplorerSelectionMode } from './file-explorer-selection'
import type { TreeNode } from './file-explorer-types'
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function nodes(count: number): TreeNode[] {
  return Array.from({ length: count }, (_, index) => ({
    name: `file${index}.ts`,
    path: `/folder/file${index}.ts`,
    relativePath: `file${index}.ts`,
    isDirectory: false,
    depth: 0,
    operationOwner: { kind: 'ssh', connectionId: 'host-one' }
  }))
}
it.each([1, 12, 128, 1000])(
  'keeps actual bare-key selection/full callbacks with %s rows',
  (count) => {
    const rows = nodes(count)
    const projection = createFileExplorerRowProjection(rows)
    const order = vi.spyOn(projection, 'getOrderedPaths')
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const focus = vi.fn()
    const scroll = vi.fn()
    const view = renderHook(() => useFileExplorerSelection(projection, false))
    const keys = ['ArrowDown', 'ArrowDown', 'End', 'Home']
    const targets = [0, Math.min(1, count - 1), count - 1, 0]
    for (let turn = 0; turn < keys.length; turn++) {
      const event = new KeyboardEvent('keydown', { key: keys[turn], cancelable: true })
      let handled = false
      act(() => {
        handled = applyFileExplorerNavigation(
          {
            rowProjection: projection,
            activeWorktreeId: 'folder:remote',
            selectedNode: projection.getRowByPath(view.result.current.selectedPath ?? ''),
            isExpanded: () => false,
            findFocusedIndex: () => null,
            handlers: {
              moveSelection: view.result.current.moveSelection,
              toggleDir: vi.fn(),
              focusRowAtIndex: focus,
              scrollToIndex: scroll
            }
          },
          event
        )
      })
      expect(handled).toBe(true)
      expect(event.defaultPrevented).toBe(true)
      expect(view.result.current.selectedPath).toBe(rows[targets[turn]].path)
      expect([...view.result.current.selectedPaths]).toEqual([rows[targets[turn]].path])
    }
    expect(frames).toHaveLength(4)
    for (const frame of frames) {
      frame(16)
    }
    expect(focus.mock.calls).toEqual(targets.map((index) => [index]))
    expect(scroll.mock.calls).toEqual(focus.mock.calls)
    const builtPathEntries = order.mock.results.reduce((total, result) => {
      if (result.type !== 'return') {
        throw new Error('Projection did not return ordered paths')
      }
      return total + result.value.length
    }, 0)
    expect(builtPathEntries).toBe(0)
    expect(order).toHaveBeenCalledTimes(0)
  }
)
it.each([false, true])(
  'keeps full selection semantics and latest projection, isMac=%s',
  (isMac) => {
    const first = nodes(12)
    const next = nodes(12).toReversed()
    const projection = createFileExplorerRowProjection(first)
    const replacement = createFileExplorerRowProjection(next)
    const order = vi.spyOn(projection, 'getOrderedPaths')
    const replacementOrder = vi.spyOn(replacement, 'getOrderedPaths')
    const view = renderHook(({ current }) => useFileExplorerSelection(current, isMac), {
      initialProps: { current: projection }
    })
    const savedMove = view.result.current.moveSelection
    const selectedIndexes: (number | null)[][] = [
      [0],
      [0, 1, 2, 3],
      [0, 1, 2, 3, 6],
      [0, 1, 2, 3, 6, 7, 8, 9],
      [11],
      [11, 8],
      [null],
      [2]
    ]
    const modes: FileExplorerSelectionMode[] = [
      'replace',
      'range',
      'toggle',
      'additive-range',
      'replace',
      'toggle',
      'range',
      'replace'
    ]
    for (let index = 0; index < modes.length; index++) {
      const rows = index < 4 ? first : next
      if (index === 4) {
        view.rerender({ current: replacement })
      }
      const target = index === 6 ? '' : rows[(index * 3) % rows.length].path
      act(() => savedMove(target, modes[index]))
      expect(view.result.current.selectedPath).toBe(target)
      expect([...view.result.current.selectedPaths]).toEqual(
        selectedIndexes[index].map((entry) => (entry === null ? '' : first[entry].path))
      )
      expect(view.result.current.moveSelection).toBe(savedMove)
    }
    expect(order).toHaveBeenCalledTimes(3)
    expect(replacementOrder).toHaveBeenCalledTimes(2)
  }
)

it('keeps empty/missing replacement and repeated-selection identity behavior', () => {
  const empty = createFileExplorerRowProjection([])
  const order = vi.spyOn(empty, 'getOrderedPaths')
  const view = renderHook(() => useFileExplorerSelection(empty, false))
  act(() => view.result.current.moveSelection('missing', 'replace'))
  const previous = view.result.current.selectedPaths
  expect([...previous]).toEqual(['missing'])
  act(() => view.result.current.moveSelection('missing', 'replace'))
  expect(view.result.current.selectedPath).toBe('missing')
  expect([...view.result.current.selectedPaths]).toEqual(['missing'])
  expect(view.result.current.selectedPaths).not.toBe(previous)
  act(() => view.result.current.moveSelection('', 'replace'))
  expect(view.result.current.selectedPath).toBe('')
  expect(view.result.current.selectedPaths.size).toBe(0)
  act(() => view.result.current.moveSelection('', 'range'))
  expect(view.result.current.selectedPath).toBe('')
  expect([...view.result.current.selectedPaths]).toEqual([''])
  expect(order).toHaveBeenCalledTimes(1)
})
it.each(['altKey', 'metaKey', 'ctrlKey'] as const)(
  'preserves navigation admission for %s',
  (modifier) => {
    const rows = nodes(12)
    const projection = createFileExplorerRowProjection(rows)
    const order = vi.spyOn(projection, 'getOrderedPaths')
    const view = renderHook(() => useFileExplorerSelection(projection, false))
    const handlers = {
      moveSelection: view.result.current.moveSelection,
      toggleDir: vi.fn(),
      focusRowAtIndex: vi.fn(),
      scrollToIndex: vi.fn()
    }
    const frame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', frame)
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      [modifier]: true,
      cancelable: true
    })
    let handled = true
    act(() => {
      handled = applyFileExplorerNavigation(
        {
          rowProjection: projection,
          activeWorktreeId: 'folder:remote',
          selectedNode: null,
          isExpanded: () => false,
          findFocusedIndex: () => null,
          handlers
        },
        event
      )
    })
    expect(handled).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(view.result.current.selectedPath).toBeNull()
    expect(view.result.current.selectedPaths.size).toBe(0)
    expect(order).not.toHaveBeenCalled()
    expect(frame).not.toHaveBeenCalled()
  }
)
it.each([false, true])(
  'preserves actual click modifier and replacement callback policy, isMac=%s',
  (isMac) => {
    const rows = nodes(12)
    const projection = createFileExplorerRowProjection(rows)
    const order = vi.spyOn(projection, 'getOrderedPaths')
    const view = renderHook(() => useFileExplorerSelection(projection, isMac))
    const replace = vi.fn((node: TreeNode) => view.result.current.setSingleSelectedPath(node.path))
    const buttons = render(
      <>
        {rows.slice(0, 4).map((node) => (
          <button
            key={node.path}
            onClick={(event) => view.result.current.selectRowWithModifiers(node, event, replace)}
          >
            {node.name}
          </button>
        ))}
      </>
    )
    const controls = buttons.getAllByRole('button')
    fireEvent.click(controls[0])
    expect(replace.mock.calls).toEqual([[rows[0]]])
    expect([...view.result.current.selectedPaths]).toEqual([rows[0].path])
    expect(order).not.toHaveBeenCalled()
    fireEvent.click(controls[2], { shiftKey: true })
    expect([...view.result.current.selectedPaths]).toEqual(
      rows.slice(0, 3).map((node) => node.path)
    )
    fireEvent.click(controls[3], isMac ? { metaKey: true } : { ctrlKey: true })
    expect([...view.result.current.selectedPaths]).toEqual(
      rows.slice(0, 4).map((node) => node.path)
    )
    expect(replace).toHaveBeenCalledTimes(1)
    expect(order).toHaveBeenCalledTimes(2)
  }
)
