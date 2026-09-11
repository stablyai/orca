// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { usePierreDiffNativeView } from './use-pierre-diff-native-view'

const state = vi.hoisted(() => ({
  read: vi.fn(),
  restore: vi.fn(),
  remember: vi.fn(),
  saved: {
    scrollLeft: 120,
    selection: {
      range: { startLineNumber: 1, startColumn: 2, endLineNumber: 1, endColumn: 5 },
      side: 'deletions',
      signature: 'same',
      backward: false
    }
  }
}))
vi.mock('./pierre-diff-native-view-state', () => ({
  getPierreNativeView: () => state.saved,
  readPierreNativeSelection: state.read,
  restorePierreNativeSelection: state.restore,
  rememberPierreNativeView: state.remember
}))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

function setup(activeGroup = 'left') {
  const frames = new Map<number, FrameRequestCallback>()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const container = document.createElement('div')
  container.dataset.tabGroupBodyId = 'left'
  const host = document.createElement('div')
  container.append(host)
  document.body.append(container)
  const instance = {
    getCodeScrollLeft: () => state.saved.scrollLeft,
    setCodeScrollLeft: vi.fn()
  } as unknown as PierreDiffInstance
  const editorRef = { current: { setDeletedTextSelectionActive: vi.fn() } }
  const containerRef = { current: container }
  state.restore.mockReturnValue(true)
  const hook = renderHook(
    ({ activeGroup }) =>
      usePierreDiffNativeView(
        'file',
        {} as FileDiffMetadata,
        true,
        containerRef,
        activeGroup,
        editorRef
      ),
    { initialProps: { activeGroup } }
  )
  act(() => hook.result.current(host, 'mount', instance))
  const tick = () =>
    act(() => {
      const pending = [...frames.values()]
      frames.clear()
      for (const callback of pending) {
        callback(0)
      }
    })
  return { ...hook, tick, container, editorRef }
}

it('reapplies native selection when editor initialization replaces the selected nodes', () => {
  const { tick } = setup()
  tick()
  expect(state.restore).toHaveBeenCalledTimes(1)
  tick()
  expect(state.restore).toHaveBeenCalledTimes(2)
  state.read.mockReturnValue(state.saved.selection)
  tick()
  tick()
  expect(state.restore).toHaveBeenCalledTimes(2)
})

it('does not replace selection in another active split group', () => {
  const { tick, rerender } = setup('right')
  tick()
  expect(state.restore).not.toHaveBeenCalled()
  rerender({ activeGroup: 'left' })
  tick()
  expect(state.restore).toHaveBeenCalledOnce()
})

it('still restores when the user switches back to the group long after attach', () => {
  const realNow = Date.now
  try {
    const { tick, rerender } = setup('right')
    tick()
    expect(state.restore).not.toHaveBeenCalled()
    // Why: a tab-group switch is a discrete user action minutes later, not render churn. A
    // ceiling anchored at first attach would have expired and dropped the restore entirely.
    const later = realNow() + 120_000
    Date.now = () => later
    rerender({ activeGroup: 'left' })
    tick()
    expect(state.restore).toHaveBeenCalledOnce()
  } finally {
    Date.now = realNow
  }
})

it('cancels delayed restoration when the user interacts elsewhere', () => {
  const { tick } = setup()
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
  tick()
  expect(state.restore).not.toHaveBeenCalled()
})
