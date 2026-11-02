import type { SetStateAction } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'

const readRuntimeDirectoryPage = vi.fn()
const readRuntimeDirectory = vi.fn()
let hostPages = true
vi.mock('@/runtime/runtime-directory-page-client', () => ({
  readRuntimeDirectoryPage: (...args: unknown[]) => readRuntimeDirectoryPage(...args),
  runtimeDirectoryPagesSupported: () => hostPages
}))
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ target: { kind: 'local' }, connectionId: null }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import {
  FILE_EXPLORER_DIR_PAGE_ENTRIES,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { appendFileExplorerDirPage, loadMoreFileExplorerDir } from './file-explorer-dir-pages'

import { fileExplorerDirsDueForMore } from './use-file-explorer-load-more'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import type { DirCache } from './file-explorer-types'
import {
  dirEntryPageAfter,
  dirListingTooLargeForRemoteMessage,
  type DirEntryCursor
} from '../../../../shared/file-dir-page'

const file = (name: string): DirEntry => ({ name, isDirectory: false, isSymlink: false })
const names = (count: number, from = 0): DirEntry[] =>
  Array.from({ length: count }, (_, index) => file(`f${String(from + index).padStart(5, '0')}`))

/** A host folder of `total` sorted files: refused whole past `wholeLimit`, served in pages. */
function serveFolder(total: number, wholeLimit = 50_000): void {
  readRuntimeDirectory.mockImplementation(async () => {
    if (total > wholeLimit) {
      throw new Error(dirListingTooLargeForRemoteMessage(total))
    }
    return names(total)
  })
  const listing = names(total)
  readRuntimeDirectoryPage.mockImplementation(
    async (_context, _dirPath, page: { after?: DirEntryCursor; limit: number }) =>
      dirEntryPageAfter(listing, page.after, page.limit)
  )
}

beforeEach(() => {
  readRuntimeDirectoryPage.mockReset()
  readRuntimeDirectory.mockReset()
  hostPages = true
})

describe('paged folder listing', () => {
  it('pages a folder the host refuses whole, and remembers where the rest starts', async () => {
    serveFolder(60_000)
    const listing = await readFileExplorerDirectory('wt-1', '/w', '/w')
    expect(listing.entries).toHaveLength(FILE_EXPLORER_DIR_PAGE_ENTRIES)
    expect(listing.paged).toBe(true)
    expect(listing.more).toEqual({ after: { name: 'f04999', isDirectory: false } })
  })

  it('keeps the refusal from a host that cannot page', async () => {
    serveFolder(60_000)
    hostPages = false
    await expect(readFileExplorerDirectory('wt-1', '/w', '/w')).rejects.toThrow(
      'too many to list over a remote connection.'
    )
    expect(readRuntimeDirectoryPage).not.toHaveBeenCalled()
  })

  it('refreshes a paged folder in pages, re-reading as many rows as were shown', async () => {
    serveFolder(60_000)
    const listing = await readFileExplorerDirectory('wt-1', '/w', '/w', {
      paged: true,
      minEntries: 12_000
    })
    expect(readRuntimeDirectory).not.toHaveBeenCalled()
    expect(listing.entries).toHaveLength(15_000)
    expect(listing.more).toEqual({ after: { name: 'f14999', isDirectory: false } })

    const whole = await readFileExplorerDirectory('wt-1', '/w', '/w', {
      paged: true,
      minEntries: 59_000
    })
    expect(whole.entries).toHaveLength(60_000)
    expect(whole.more).toBeUndefined()
  })

  it('appends a page in order, keeping a row the watcher already added once', () => {
    const owner = { kind: 'local' as const }
    const cache: DirCache = {
      children: [
        { name: 'f00000', path: '/w/f00000', relativePath: 'f00000', isDirectory: false, depth: 0 },
        { name: 'f00003', path: '/w/f00003', relativePath: 'f00003', isDirectory: false, depth: 0 }
      ],
      operationOwner: owner,
      more: { after: { name: 'f00000', isDirectory: false } }
    }
    const appended = appendFileExplorerDirPage(
      cache,
      { entries: names(3, 1), operationOwner: owner },
      '/w',
      -1,
      '/w'
    )
    expect(appended.children.map((child) => child.name)).toEqual([
      'f00000',
      'f00001',
      'f00002',
      'f00003'
    ])
    expect(appended.more).toBeUndefined()
  })

  it('does not extend rows with a page from another host', () => {
    const cache: DirCache = {
      children: [],
      operationOwner: { kind: 'local' },
      more: { after: { name: 'f00000', isDirectory: false } }
    }
    const appended = appendFileExplorerDirPage(
      cache,
      { entries: names(1), operationOwner: { kind: 'ssh', connectionId: 'c' } },
      '/w',
      -1,
      '/w'
    )
    expect(appended).toEqual({ children: [], operationOwner: { kind: 'local' } })
  })
})

describe('loading more on scroll', () => {
  const partial = (lastPath: string): DirCache => ({
    children: [
      { name: 'last', path: lastPath, relativePath: 'last', isDirectory: false, depth: 0 }
    ],
    more: { after: { name: 'f00000', isDirectory: false } }
  })

  it('appends the next page, and a refresh started meanwhile wins', async () => {
    serveFolder(60_000)
    let dirCache: Record<string, DirCache> = {
      '/w': {
        children: [],
        operationOwner: { kind: 'local' },
        more: { after: { name: 'f56999', isDirectory: false } }
      }
    }
    const setDirCache = (update: SetStateAction<Record<string, DirCache>>): void => {
      dirCache = typeof update === 'function' ? update(dirCache) : update
    }
    let loading: ReadonlySet<string> = new Set()
    const tracker = createFileExplorerDirLoadTracker()
    const params = {
      dirPath: '/w',
      activeWorktreeId: 'wt-1',
      worktreePath: '/w',
      dirLoadTracker: tracker,
      setDirCache,
      updateLoadingDirPaths: (update: (prev: ReadonlySet<string>) => ReadonlySet<string>) => {
        loading = update(loading)
      }
    }

    await loadMoreFileExplorerDir({ ...params, dirCache, loadingDirPaths: loading })
    expect(dirCache['/w'].children).toHaveLength(3_000)
    expect(dirCache['/w'].children[0].name).toBe('f57000')
    expect(dirCache['/w'].more).toBeUndefined()
    expect(loading.size).toBe(0)

    dirCache = {
      '/w': {
        ...dirCache['/w'],
        children: [],
        more: { after: { name: 'f00000', isDirectory: false } }
      }
    }
    const pending = loadMoreFileExplorerDir({ ...params, dirCache, loadingDirPaths: loading })
    tracker.begin('/w')
    await pending
    expect(dirCache['/w'].children).toHaveLength(0)
  })

  it('marks a failed page so scrolling does not retry it until a refresh', async () => {
    readRuntimeDirectoryPage.mockRejectedValueOnce(new Error('host gone'))
    let dirCache: Record<string, DirCache> = {
      '/w': { ...partial('/w/last'), operationOwner: { kind: 'local' } }
    }
    await loadMoreFileExplorerDir({
      dirPath: '/w',
      activeWorktreeId: 'wt-1',
      worktreePath: '/w',
      dirCache,
      loadingDirPaths: new Set(),
      dirLoadTracker: createFileExplorerDirLoadTracker(),
      setDirCache: (update) => {
        dirCache = typeof update === 'function' ? update(dirCache) : update
      },
      updateLoadingDirPaths: () => {}
    })
    expect(dirCache['/w'].error).toBeDefined()
    expect(fileExplorerDirsDueForMore(dirCache, new Set(), { getIndexByPath: () => 0 }, 0)).toEqual(
      []
    )
  })
})
