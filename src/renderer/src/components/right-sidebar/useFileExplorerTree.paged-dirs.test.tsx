// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

const AFTER_B = { name: 'b', isDirectory: false }
const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })

function page(names: string[], more?: { after: { name: string; isDirectory: boolean } }) {
  return { entries: names.map(file), operationOwner: { kind: 'local' as const }, more, paged: true }
}

function heldPage() {
  let resolve!: (value: ReturnType<typeof page>) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ReturnType<typeof page>>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('useFileExplorerTree paged folders', () => {
  afterEach(() => {
    cleanup()
    readDirectoryMock.mockReset()
  })

  it('lists a big folder a page at a time and keeps every listed row on refresh', async () => {
    const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt-1'))
    readDirectoryMock.mockResolvedValueOnce(page(['a', 'b'], { after: AFTER_B }))
    await act(async () => {
      await result.current.loadDir('/repo', -1, { force: true })
    })
    expect(result.current.dirCache['/repo'].more).toEqual({ after: AFTER_B })

    readDirectoryMock.mockResolvedValueOnce(page(['c', 'd']))
    await act(async () => {
      await result.current.loadMoreDir('/repo')
    })
    expect(readDirectoryMock).toHaveBeenLastCalledWith('wt-1', '/repo', '/repo', {
      paged: true,
      after: AFTER_B
    })
    expect(result.current.dirCache['/repo'].children.map((child) => child.name)).toEqual([
      'a',
      'b',
      'c',
      'd'
    ])
    expect(result.current.dirCache['/repo'].more).toBeUndefined()

    readDirectoryMock.mockResolvedValueOnce(page(['a', 'b', 'c', 'd']))
    await act(async () => {
      await result.current.refreshDir('/repo')
    })
    expect(readDirectoryMock).toHaveBeenLastCalledWith('wt-1', '/repo', '/repo', {
      wakeWslDistro: undefined,
      paged: true,
      minEntries: 4
    })
    expect(result.current.dirCache['/repo'].children).toHaveLength(4)
  })

  it('does nothing for a folder that was listed whole', async () => {
    const { result } = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt-1'))
    readDirectoryMock.mockResolvedValueOnce({ ...page(['a']), paged: undefined })
    await act(async () => {
      await result.current.loadDir('/repo', -1, { force: true })
    })
    readDirectoryMock.mockClear()
    await act(async () => {
      await result.current.loadMoreDir('/repo')
    })
    expect(readDirectoryMock).not.toHaveBeenCalled()
  })

  it.each(['success', 'error'] as const)(
    'retires a held page promptly and preserves its successor after late old %s',
    async (late) => {
      const hook = renderHook(() => useFileExplorerTree('/repo', new Set(), 'wt-1'))
      readDirectoryMock.mockResolvedValueOnce(page(['a', 'b'], { after: AFTER_B }))
      await act(async () => {
        await hook.result.current.loadDir('/repo', -1)
      })
      const old = heldPage(),
        current = heldPage()
      readDirectoryMock.mockReturnValueOnce(old.promise)
      let retired!: Promise<void>
      act(() => {
        retired = hook.result.current.loadMoreDir('/repo')
      })
      expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(true)
      act(() => hook.result.current.retireView())
      await act(async () => {
        await retired
      })
      expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(false)

      readDirectoryMock.mockResolvedValueOnce(page(['a', 'b'], { after: AFTER_B }))
      await act(async () => {
        await hook.result.current.loadDir('/repo', -1, { force: true })
      })
      readDirectoryMock.mockReturnValueOnce(current.promise)
      let successor!: Promise<void>
      act(() => {
        successor = hook.result.current.loadMoreDir('/repo')
      })
      await act(async () => {
        if (late === 'success') {
          old.resolve(page(['obsolete']))
        } else {
          old.reject(new Error('old host error'))
        }
      })
      expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(true)
      expect(hook.result.current.dirCache['/repo'].error).toBeUndefined()
      expect(hook.result.current.dirCache['/repo'].children.map((node) => node.name)).toEqual([
        'a',
        'b'
      ])
      expect(hook.result.current.getRevealAuthority(['/repo'], hook.result.current.dirCache)).toBe(
        'pending'
      )
      await act(async () => {
        current.resolve(page(['c']))
        await successor
      })
      expect(hook.result.current.dirCache['/repo'].children.map((node) => node.name)).toEqual([
        'a',
        'b',
        'c'
      ])
      expect(hook.result.current.loadingDirPaths.has('/repo')).toBe(false)
      expect(hook.result.current.getRevealAuthority(['/repo'], hook.result.current.dirCache)).toBe(
        'ready'
      )
      expect(readDirectoryMock).toHaveBeenCalledTimes(4)
    }
  )
})
