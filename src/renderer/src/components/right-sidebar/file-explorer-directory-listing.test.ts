import { describe, expect, it, vi } from 'vitest'

const readRuntimeDirectory = vi.fn()
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({ settings: null, connectionId: null }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import {
  fileExplorerEntriesToTreeNodes,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import { createVisibleFileExplorerRowProjection } from './useFileExplorerVisibleRowProjection'

describe('fileExplorerEntriesToTreeNodes', () => {
  // Why: issue #19198 — node_modules was dropped here, upstream of every toggle, so
  // "Show Git Ignored Files" could never restore it on any route (local, SSH, paired).
  it('keeps node_modules in the tree so the git-ignored toggle decides its visibility', async () => {
    readRuntimeDirectory.mockResolvedValueOnce([
      { name: 'node_modules', isDirectory: true, isSymlink: false },
      { name: '.git', isDirectory: true, isSymlink: false },
      { name: 'package.json', isDirectory: false, isSymlink: false }
    ])
    const listing = await readFileExplorerDirectory('wt-1', '/w', '/w')
    const children = fileExplorerEntriesToTreeNodes(
      listing.entries,
      '/w',
      -1,
      '/w',
      listing.operationOwner
    )
    expect(children.map((node) => node.relativePath)).toEqual(['node_modules', 'package.json'])

    const input = {
      dirCache: { '/w': { children } },
      expanded: new Set<string>(),
      worktreePath: '/w'
    }
    const ignoredSet = new Set(['node_modules'])
    const visible = (showGitIgnoredFiles: boolean): string[] => {
      const projection = createVisibleFileExplorerRowProjection(input, {
        ignoredSet,
        showDotfiles: true,
        showGitIgnoredFiles
      })
      return projection
        .getVisibleSlice(0, projection.getVisibleCount() - 1)
        .map((row) => row.relativePath)
    }
    expect(visible(true)).toEqual(['node_modules', 'package.json'])
    expect(visible(false)).toEqual(['package.json'])
  })
})

describe('readFileExplorerDirectory', () => {
  it('re-sorts backend order — remote-runtime and paired-web routes return the host order verbatim', async () => {
    readRuntimeDirectory.mockResolvedValueOnce([
      { name: '100 - b.txt', isDirectory: false, isSymlink: false },
      { name: '9 - c.txt', isDirectory: false, isSymlink: false },
      { name: '10 - dir', isDirectory: true, isSymlink: false },
      { name: '99 - a.txt', isDirectory: false, isSymlink: false }
    ])

    const { entries } = await readFileExplorerDirectory('wt-1', '/w', '/w/dir')
    expect(entries.map((e) => e.name)).toEqual([
      '10 - dir',
      '9 - c.txt',
      '99 - a.txt',
      '100 - b.txt'
    ])
  })
})
