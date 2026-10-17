import { describe, expect, it, vi } from 'vitest'

const readRuntimeDirectory = vi.fn()
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
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

it('preserves the host directory classification with default Quick Open preferences', async () => {
  readRuntimeDirectory.mockResolvedValueOnce([
    { name: 'linked', isDirectory: true, isSymlink: true }
  ])
  const { entries } = await readFileExplorerDirectory('wt-1', '/w', '/w')
  expect(entries).toEqual([{ name: 'linked', isDirectory: true, isSymlink: true }])
  expect(readRuntimeDirectory).toHaveBeenLastCalledWith(expect.anything(), '/w', undefined)
})

it('declares user-directory access only for listings outside the workspace', async () => {
  readRuntimeDirectory.mockResolvedValue([])

  await readFileExplorerDirectory('wt-1', '/workspace', '/tmp/reference')

  expect(readRuntimeDirectory).toHaveBeenLastCalledWith(expect.anything(), '/tmp/reference', {
    access: { kind: 'user-directory' }
  })
})

it('gives outside nodes absolute identities so workspace git status cannot decorate them', () => {
  expect(
    fileExplorerEntriesToTreeNodes(
      [{ name: 'package.json', isDirectory: false, isSymlink: false }],
      '/tmp/reference',
      -1,
      '/workspace',
      { kind: 'local' }
    )
  ).toEqual([
    expect.objectContaining({
      path: '/tmp/reference/package.json',
      relativePath: '/tmp/reference/package.json',
      depth: 0
    })
  ])
})
