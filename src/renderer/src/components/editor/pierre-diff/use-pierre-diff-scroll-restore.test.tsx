// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { diffScrollTopCache } from '@/lib/scroll-cache'
import { buildPierreFileDiff } from './pierre-diff-metadata'
import type { PierreDiffInstance } from './PierreDiffSurface'
import { usePierreDiffScrollRestore } from './use-pierre-diff-scroll-restore'

const diff = buildPierreFileDiff({
  path: 'file',
  status: 'modified',
  cacheKey: 'file',
  originalContent: 'one\ntwo\n',
  modifiedContent: 'one\nTWO\n',
  parseDiffOptions: {}
})
const instance = {
  getLinePosition: vi.fn(() => ({ top: 900, height: 20 }))
} as unknown as PierreDiffInstance
let container: HTMLDivElement
let host: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  diffScrollTopCache.clear()
  container = document.createElement('div')
  host = document.createElement('div')
  container.append(host)
  document.body.append(container)
  Object.defineProperty(container, 'clientHeight', { value: 600 })
  vi.spyOn(host, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 1200 } as DOMRect)
})
afterEach(() => {
  cleanup()
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it('waits for painted rows before restoring and leaves subsequent user scrolling alone', () => {
  diffScrollTopCache.set('file', 400)
  const { result, unmount } = renderHook(() =>
    usePierreDiffScrollRestore('file', { current: container }, diff)
  )
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(0)
  act(() => result.current(host, 'mount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(400)
  container.scrollTop = 700
  act(() => result.current(host, 'update', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(700)
  unmount()
  expect(diffScrollTopCache.get('file')).toBe(700)
})

it('does not replace saved scroll with the loading placeholder position', () => {
  diffScrollTopCache.set('file', 400)
  const { unmount } = renderHook(() =>
    usePierreDiffScrollRestore('file', { current: container }, null)
  )
  unmount()
  expect(diffScrollTopCache.get('file')).toBe(400)
})

it('centers the first change using virtual row coordinates before that row is mounted', () => {
  const { result } = renderHook(() =>
    usePierreDiffScrollRestore('file', { current: container }, diff)
  )
  act(() => result.current(host, 'mount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(instance.getLinePosition).toHaveBeenCalledWith(2, 'additions')
  expect(container.scrollTop).toBe(700)
})

it('cancels pending restoration when the viewer or Pierre instance unmounts', () => {
  diffScrollTopCache.set('file', 400)
  const { result, unmount } = renderHook(() =>
    usePierreDiffScrollRestore('file', { current: container }, diff)
  )
  act(() => result.current(host, 'mount', instance))
  act(() => result.current(host, 'unmount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(0)
  act(() => result.current(host, 'mount', instance))
  unmount()
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(0)
  expect(diffScrollTopCache.get('file')).toBe(400)
})

it('retries after a hidden renderer acquires a layout', () => {
  const { result } = renderHook(() =>
    usePierreDiffScrollRestore('file', { current: container }, diff)
  )
  vi.mocked(host.getBoundingClientRect).mockReturnValueOnce({ top: 0, height: 0 } as DOMRect)
  act(() => result.current(host, 'mount', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(0)
  act(() => result.current(host, 'update', instance))
  act(() => vi.runOnlyPendingTimers())
  expect(container.scrollTop).toBe(700)
})
