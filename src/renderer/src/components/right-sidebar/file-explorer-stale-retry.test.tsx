// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DirCache } from './file-explorer-types'
import { useFileExplorerTreeLoadEffects } from './use-file-explorer-tree-load-effects'

afterEach(cleanup)
function pendingRefresh() {
  let resolve!: () => void
  const promise = new Promise<void>((finish) => {
    resolve = finish
  })
  return { promise, resolve }
}
function params(path = '/repo') {
  const dir = `${path}/link`
  const stale = new Set([dir])
  const dirCache: Record<string, DirCache> = { [dir]: { children: [] } }
  const errors: { rootError: string | null } = { rootError: null }
  return {
    stale,
    props: {
      visibleFilesWorktreePath: path,
      expanded: new Set([dir]),
      dirCache,
      loadingDirPaths: new Set([dir]),
      ...errors,
      isDirStale: (candidate: string) => stale.has(candidate),
      loadDir: vi.fn().mockResolvedValue(true),
      refreshTree: vi.fn<() => Promise<unknown>>(),
      resetAndLoad: vi.fn(),
      resetSelection: vi.fn(),
      setNameFilterQuery: vi.fn()
    }
  }
}
it('runs one bounded retry across root and expanded-wave loading transitions', async () => {
  const { props, stale } = params()
  const pending = pendingRefresh()
  props.refreshTree.mockReturnValue(pending.promise)
  const hook = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  hook.rerender({ ...props, loadingDirPaths: new Set() })
  expect(props.refreshTree).toHaveBeenCalledTimes(1)
  for (const loading of [
    new Set(['/repo']),
    new Set<string>(),
    new Set(['/repo/link']),
    new Set<string>()
  ]) {
    hook.rerender({ ...props, loadingDirPaths: loading })
    await act(async () => {
      await Promise.resolve()
    })
    expect(props.refreshTree).toHaveBeenCalledTimes(1)
  }
  stale.clear()
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(props.refreshTree).toHaveBeenCalledTimes(1)
  expect(props.loadDir).not.toHaveBeenCalled()
})
it.each(['fresh-empty', 'directory-error', 'root-error'])('does not loop on %s', async (state) => {
  const { props, stale } = params()
  if (state === 'fresh-empty') {
    stale.clear()
  }
  if (state === 'directory-error') {
    props.dirCache['/repo/link'].error = 'ENOENT'
  }
  if (state === 'root-error') {
    props.rootError = 'ETIMEDOUT'
  }
  const hook = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  for (let i = 0; i < 3; i++) {
    hook.rerender({ ...props, loadingDirPaths: new Set() })
    await act(async () => {
      await Promise.resolve()
    })
  }
  expect(props.refreshTree).not.toHaveBeenCalled()
  expect(props.loadDir).not.toHaveBeenCalled()
})
it.each(['root', 'directory'])('stops after a retry records a %s error', async (failure) => {
  const { props } = params()
  const pending = pendingRefresh()
  props.refreshTree.mockReturnValue(pending.promise)
  const hook = renderHook(useFileExplorerTreeLoadEffects, { initialProps: props })
  hook.rerender({ ...props, loadingDirPaths: new Set() })
  expect(props.refreshTree).toHaveBeenCalledTimes(1)
  if (failure === 'root') {
    props.rootError = 'ETIMEDOUT'
  } else {
    props.dirCache['/repo/link'].error = 'ENOENT'
  }
  hook.rerender({ ...props, loadingDirPaths: new Set() })
  await act(async () => {
    pending.resolve()
    await pending.promise
  })
  expect(props.refreshTree).toHaveBeenCalledTimes(1)
})
it('does not let an old workspace completion release a new workspace retry', async () => {
  const first = params('/first')
  const second = params('/second')
  const oldRefresh = pendingRefresh()
  const newRefresh = pendingRefresh()
  first.props.refreshTree.mockReturnValue(oldRefresh.promise)
  second.props.refreshTree.mockReturnValue(newRefresh.promise)
  const hook = renderHook(useFileExplorerTreeLoadEffects, { initialProps: first.props })
  hook.rerender({ ...first.props, loadingDirPaths: new Set() })
  hook.rerender(second.props)
  hook.rerender({ ...second.props, loadingDirPaths: new Set() })
  expect(second.props.refreshTree).toHaveBeenCalledTimes(1)
  await act(async () => {
    oldRefresh.resolve()
    await oldRefresh.promise
  })
  hook.rerender({ ...second.props, loadingDirPaths: new Set() })
  expect(first.props.refreshTree).toHaveBeenCalledTimes(1)
  expect(second.props.refreshTree).toHaveBeenCalledTimes(1)
  second.stale.clear()
  await act(async () => {
    newRefresh.resolve()
    await newRefresh.promise
  })
  expect(second.props.refreshTree).toHaveBeenCalledTimes(1)
})
