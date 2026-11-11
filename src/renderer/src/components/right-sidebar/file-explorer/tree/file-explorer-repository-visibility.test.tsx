// @vitest-environment happy-dom
import { useEffect, useMemo, useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import {
  FileExplorerRepositoryObserver,
  type ExplorerRepositorySource
} from './file-explorer-repository-observer'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { buildExplorerRepositoryDecorations } from './file-explorer-repository-decorations'
import type { DirCache } from './file-explorer-types'

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: { showGitIgnoredFiles: true } })
}))
vi.mock('./use-file-explorer-ignored-paths', () => ({ useFileExplorerIgnoredPaths: () => [] }))
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('preserves demanded capped badges and ignore truth across the real hidden projection seam', async () => {
  vi.useFakeTimers()
  let mode: 'complete' | 'partial' | 'error' = 'complete'
  let observer!: FileExplorerRepositoryObserver
  const expanded = new Set(['/w/repo'])
  const node = (name: string, directory: boolean) => ({
    name: name.split('/').at(-1)!,
    path: `/w/${name}`,
    relativePath: name,
    isDirectory: directory,
    depth: 0
  })
  const cache: Record<string, DirCache> = {
    '/w': { children: [node('repo', true)] },
    '/w/repo': { children: [node('repo/keep.txt', false)] }
  }
  const { result, rerender, unmount } = renderHook(
    ({ visible }) => {
      const [sources, publish] = useState<readonly ExplorerRepositorySource[]>([])
      const instance = useMemo(
        () =>
          new FileExplorerRepositoryObserver(async (request) => {
            if (mode === 'error') {
              throw new Error('offline')
            }
            return [
              {
                path: 'repo',
                kind: 'repository',
                ...(request.repositoryIntent === 'status'
                  ? {
                      status: {
                        entries: [
                          {
                            path: mode === 'complete' ? 'keep.txt' : 'other.txt',
                            status: 'modified',
                            area: 'unstaged'
                          }
                        ],
                        conflictOperation: 'unknown',
                        didHitLimit: mode === 'partial'
                      }
                    }
                  : { ignoredPaths: ['keep.txt'] })
              }
            ]
          }, publish),
        []
      )
      observer = instance
      useEffect(() => {
        instance.setFrontier([{ path: 'repo', marker: true }], ['repo', 'repo/keep.txt'])
        instance.setVisible(visible)
      }, [instance, visible])
      useEffect(() => () => instance.dispose(), [instance])
      const setDemand = useMemo(() => instance.setDemand.bind(instance), [instance])
      useFileExplorerVisibleRowProjection(
        'folder:w',
        visible ? '/w' : null,
        cache,
        expanded,
        false,
        true,
        null,
        null,
        visible ? '/w' : null,
        { sources, setDemand }
      )
      return sources
    },
    { initialProps: { visible: true } }
  )
  await act(() => vi.advanceTimersByTimeAsync(4000))
  mode = 'partial'
  act(() => observer.invalidate('repo/keep.txt'))
  await act(() => vi.advanceTimersByTimeAsync(4000))
  const badge = () =>
    buildExplorerRepositoryDecorations([], result.current).statusByRelativePath.get('repo/keep.txt')
  expect(badge()).toBe('modified')
  rerender({ visible: false })
  expect(badge()).toBe('modified')
  expect(result.current[0].ignored.get('keep.txt')).toBe(true)
  mode = 'error'
  rerender({ visible: true })
  await act(() => vi.advanceTimersByTimeAsync(4000))
  expect(badge()).toBe('modified')
  expect(result.current[0].ignored.get('keep.txt')).toBe(true)
  unmount()
})
