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
})
