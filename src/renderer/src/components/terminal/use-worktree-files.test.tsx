// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import type * as StoreModule from '@/store'
import { createTestStore, makeOpenFile } from '@/store/slices/store-test-helpers'
import { useWorktreeFiles } from './use-worktree-files'

const holder = vi.hoisted((): { store?: StoreApi<AppState> } => ({}))
vi.mock('@/store', async (load) => {
  const actual = await load<typeof StoreModule>()
  const { useStore } = await import('zustand')
  return {
    ...actual,
    useAppStore: <T,>(selector: (state: AppState) => T) => {
      if (!holder.store) {
        throw new Error('missing test store')
      }
      return useStore(holder.store, selector)
    }
  }
})
const ACTIVE = 'repo::/active'
const OTHER = 'repo::/other'
function countedFiles(count: number) {
  let reads = 0
  const files = Array.from({ length: count }, (_, at) => {
    const file = makeOpenFile({ id: `file-${at}`, worktreeId: at % 2 ? OTHER : ACTIVE })
    return new Proxy(file, {
      get(target, key, receiver) {
        if (key === 'worktreeId') {
          reads++
        }
        return Reflect.get(target, key, receiver)
      }
    })
  })
  return { files, reads: () => reads }
}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('useWorktreeFiles', () => {
  it('selects 5000 current files and does no population work across 100 unchanged renders and unrelated writes', async () => {
    const { files, reads } = countedFiles(10_000)
    const store = createTestStore()
    holder.store = store
    store.setState({ openFiles: files })
    const view = renderHook(({ id }) => useWorktreeFiles(id), { initialProps: { id: ACTIVE } })
    await act(async () => {})
    const first = view.result.current
    expect(first).toHaveLength(5000)
    const warmed = reads()
    expect(warmed).toBeGreaterThanOrEqual(10_000)
    for (let at = 0; at < 100; at++) {
      view.rerender({ id: ACTIVE })
      act(() => store.setState({ activeFileId: `unrelated-${at}` }))
    }
    expect(view.result.current).toBe(first)
    expect(reads()).toBe(warmed)
  })
  it('indexes cloned inputs correctly and delivers changed records, members, workspace and null', () => {
    const { files, reads } = countedFiles(10)
    const store = createTestStore()
    holder.store = store
    store.setState({ openFiles: files })
    const view = renderHook(({ id }: { id: string | null }) => useWorktreeFiles(id), {
      initialProps: { id: ACTIVE }
    })
    const first = view.result.current
    expect(first).toHaveLength(5)
    const warmed = reads()
    act(() => store.setState({ openFiles: [...files] }))
    expect(view.result.current).toEqual(first)
    expect(view.result.current).toBe(first)
    expect(reads()).toBeGreaterThan(warmed)
    act(() => store.getState().markFileDirty(files[0].id, true))
    const changed = store.getState().openFiles[0]
    expect(view.result.current).not.toBe(first)
    expect(view.result.current[0]).toBe(changed)
    act(() => store.setState({ openFiles: [changed, ...files.slice(2)] }))
    expect(view.result.current).toHaveLength(5)
    view.rerender({ id: OTHER })
    expect(view.result.current).toHaveLength(4)
    view.rerender({ id: null })
    expect(view.result.current).toEqual([])
  })
})
