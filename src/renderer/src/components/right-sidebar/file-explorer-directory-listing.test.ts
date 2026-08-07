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

describe('fileExplorerEntriesToTreeNodes', () => {
  const owner = { kind: 'local' } as const

  it('keeps a link an activation already resolved to a directory expanded across re-reads', () => {
    const entries = [
      { name: 'linked-docs', isDirectory: false, isSymlink: true },
      { name: 'linked-file.md', isDirectory: false, isSymlink: true }
    ]

    const nodes = fileExplorerEntriesToTreeNodes(
      entries,
      '/w',
      -1,
      '/w',
      owner,
      new Set(['/w/linked-docs'])
    )

    expect(nodes.map((node) => [node.path, node.isDirectory])).toEqual([
      ['/w/linked-docs', true],
      ['/w/linked-file.md', false]
    ])
  })

  it('leaves unresolved links file-like', () => {
    const nodes = fileExplorerEntriesToTreeNodes(
      [{ name: 'linked-docs', isDirectory: false, isSymlink: true }],
      '/w',
      -1,
      '/w',
      owner
    )

    expect(nodes[0].isDirectory).toBe(false)
  })
})
