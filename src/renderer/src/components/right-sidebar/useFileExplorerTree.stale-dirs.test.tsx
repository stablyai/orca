// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { useFileExplorerTree } from './useFileExplorerTree'

const readDirectoryMock = vi.hoisted(() => vi.fn())
vi.mock('./file-explorer-directory-listing', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFileExplorerDirectory: readDirectoryMock
}))
vi.mock('./file-explorer-operation-owner', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getFileExplorerOperationOwner: () => ({ kind: 'local' as const })
}))

function entry(name: string, isDirectory = false): DirEntry {
  return { name, isDirectory } as DirEntry
}

function listing(...entries: DirEntry[]) {
  return { entries, operationOwner: { kind: 'local' as const } }
}

describe('useFileExplorerTree stale collapsed dirs', () => {
  beforeEach(() => {
    readDirectoryMock.mockReset()
    readDirectoryMock.mockResolvedValue(listing())
  })

  afterEach(() => {
    cleanup()
  })

  it('marks a collapsed cached dir the full refresh skipped, and clears it on the next read', async () => {
    const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt-1'))

    readDirectoryMock.mockResolvedValueOnce(listing(entry('gone.ts')))
    await act(async () => {
      await result.current.loadDir('/repo/src', 0)
    })
    expect(result.current.dirCache['/repo/src'].children).toHaveLength(1)
    expect(result.current.isDirStale('/repo/src')).toBe(false)

    // The overflow refresh reads root and the (empty) expanded set — not the collapsed /repo/src.
    readDirectoryMock.mockClear()
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(readDirectoryMock).not.toHaveBeenCalledWith('wt-1', '/repo', '/repo/src')
    expect(result.current.isDirStale('/repo/src')).toBe(true)
    // Its cached children stay put until something re-reads them.
    expect(result.current.dirCache['/repo/src'].children).toHaveLength(1)

    await act(async () => {
      await result.current.loadDir('/repo/src', 0, { force: true })
    })
    expect(result.current.isDirStale('/repo/src')).toBe(false)
    expect(result.current.dirCache['/repo/src'].children).toHaveLength(0)
  })

  it('does not mark the root or a dir the full refresh re-read', async () => {
    const expanded = new Set(['/repo/src'])
    const { result } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt-1'))

    await act(async () => {
      await result.current.loadDir('/repo/src', 0)
    })
    await act(async () => {
      await result.current.refreshTree()
    })

    expect(result.current.isDirStale('/repo')).toBe(false)
    expect(result.current.isDirStale('/repo/src')).toBe(false)
  })

  it('keeps a mark a superseded refresh never verified, even once the dir is expanded', async () => {
    // Regression guard: refreshTree used to REPLACE the mark set. A dir marked while collapsed and
    // then expanded was dropped by the replacement (expanded dirs are never marked) — and when that
    // refresh bailed on a superseded root load, nothing re-read it and nothing still called it
    // unverified, so re-expanding served the pre-overflow listing forever.
    const expanded = new Set<string>()
    const { result, rerender } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt-1'))

    readDirectoryMock.mockResolvedValueOnce(listing(entry('gone.ts')))
    await act(async () => {
      await result.current.loadDir('/repo/src', 0)
    })
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.isDirStale('/repo/src')).toBe(true)

    expanded.add('/repo/src')
    rerender()

    let releaseRoot!: () => void
    const rootGate = new Promise<void>((resolve) => {
      releaseRoot = resolve
    })
    readDirectoryMock.mockImplementationOnce(async () => {
      await rootGate
      return listing()
    })

    let refresh!: Promise<string>
    act(() => {
      refresh = result.current.refreshTree()
    })
    await act(async () => {
      // A concurrent root read supersedes this refresh's token, so it bails before the expanded set.
      void result.current.refreshDir('/repo')
      releaseRoot()
      expect(await refresh).toBe('superseded')
    })

    expect(result.current.isDirStale('/repo/src')).toBe(true)
  })

  it('does not read the expanded dirs when the root read failed', async () => {
    // Regression guard: loadDir swallows read errors unless failOnError is set, so a dead
    // transport used to report a completed root read and fan out one doomed wave per 4 dirs.
    const expanded = new Set(['/repo/a', '/repo/b'])
    const { result } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt-1'))

    readDirectoryMock.mockReset()
    readDirectoryMock.mockRejectedValue(new Error('ETIMEDOUT'))

    await act(async () => {
      expect(await result.current.refreshTree()).toBe('root-unreadable')
    })

    // Only the root read was attempted; the expanded dirs were not.
    expect(readDirectoryMock).toHaveBeenCalledTimes(1)
    expect(readDirectoryMock).toHaveBeenCalledWith('wt-1', '/repo', '/repo')
  })

  it('drops stale marks when the tree is reset for a new worktree', async () => {
    const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt-1'))

    await act(async () => {
      await result.current.loadDir('/repo/src', 0)
    })
    await act(async () => {
      await result.current.refreshTree()
    })
    expect(result.current.isDirStale('/repo/src')).toBe(true)

    await act(async () => {
      result.current.resetAndLoad()
    })
    expect(result.current.isDirStale('/repo/src')).toBe(false)
  })

  it('keeps the rendered cache bound to its loaded workspace until reset', async () => {
    const props = { path: '/repo', worktreeId: 'wt-1' }
    const { result, rerender } = renderHook(
      ({ path, worktreeId }: typeof props) => useFileExplorerTree(path, new Set(), worktreeId),
      { initialProps: props }
    )

    await act(async () => {
      await result.current.loadDir('/repo', -1)
    })
    expect(result.current.sourceWorkspaceId).toBe('wt-1')

    rerender({ path: '/repo', worktreeId: 'wt-2' })
    expect(result.current.sourceWorkspaceId).toBe('wt-1')

    await act(async () => {
      result.current.resetAndLoad()
      await Promise.resolve()
    })
    expect(result.current.sourceWorkspaceId).toBe('wt-2')
  })

  it('keeps a deferred alias read stale after collapse and a structural refresh', async () => {
    readDirectoryMock.mockReset()
    const expanded = new Set(['/repo/link'])
    const { result, rerender } = renderHook(() => useFileExplorerTree('/repo', expanded, 'wt-1'))
    readDirectoryMock.mockResolvedValueOnce(
      listing({ name: 'link', isDirectory: true, isSymlink: true })
    )
    await act(async () => {
      await result.current.loadDir('/repo', -1)
    })
    let finishAlias: (value: ReturnType<typeof listing>) => void = () => undefined
    readDirectoryMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof listing>>((resolve) => {
          finishAlias = resolve
        })
    )
    let pendingAlias: Promise<boolean> = Promise.resolve(false)
    act(() => {
      pendingAlias = result.current.loadDir('/repo/link', 0)
    })
    expanded.clear()
    rerender()
    let finishRoot: (value: ReturnType<typeof listing>) => void = () => undefined
    readDirectoryMock.mockImplementationOnce(
      () =>
        new Promise<ReturnType<typeof listing>>((resolve) => {
          finishRoot = resolve
        })
    )
    let refresh: Promise<string> = Promise.resolve('')
    act(() => {
      refresh = result.current.refreshTree()
    })
    await act(async () => {
      finishAlias(listing({ name: 'old.ts', isDirectory: false, isSymlink: false }))
      await pendingAlias
      finishRoot(listing({ name: 'link', isDirectory: true, isSymlink: true }))
      await refresh
    })
    expect(result.current.isDirStale('/repo/link')).toBe(true)
    readDirectoryMock.mockResolvedValueOnce(
      listing({ name: 'fresh.ts', isDirectory: false, isSymlink: false })
    )
    expanded.add('/repo/link')
    rerender()
    await act(async () => {
      await result.current.loadDir('/repo/link', 0, { force: true })
    })
    expect(result.current.dirCache['/repo/link'].children.map((child) => child.name)).toEqual([
      'fresh.ts'
    ])
    expect(result.current.isDirStale('/repo/link')).toBe(false)
  })
  it('an older expanded wave cannot clear newer collapsed alias staleness', async () => {
    readDirectoryMock.mockReset().mockResolvedValue(listing())
    const hook = renderHook(({ expanded }) => useFileExplorerTree('/repo', expanded, 'wt-1'), {
      initialProps: { expanded: new Set(['/repo/link']) }
    })
    readDirectoryMock.mockResolvedValueOnce(listing(entry('old.ts')))
    await act(async () => {
      await hook.result.current.loadDir('/repo/link', 0)
    })
    let releaseAlias!: (value: ReturnType<typeof listing>) => void
    const aliasGate = new Promise<ReturnType<typeof listing>>((resolve) => {
      releaseAlias = resolve
    })
    readDirectoryMock.mockImplementation(async (_id, _root, path) =>
      path === '/repo/link' ? aliasGate : listing()
    )
    let older!: Promise<string>
    await act(async () => {
      older = hook.result.current.refreshTree()
      await Promise.resolve()
    })
    expect(readDirectoryMock).toHaveBeenLastCalledWith('wt-1', '/repo', '/repo/link')
    hook.rerender({ expanded: new Set() })
    await act(async () => {
      await hook.result.current.refreshTree()
    })
    expect(hook.result.current.isDirStale('/repo/link')).toBe(true)
    await act(async () => {
      releaseAlias(listing(entry('old.ts')))
      await older
    })
    expect(hook.result.current.isDirStale('/repo/link')).toBe(true)
  })
})
