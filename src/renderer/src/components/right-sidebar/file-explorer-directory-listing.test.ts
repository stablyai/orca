import { describe, expect, it, vi } from 'vitest'

const readRuntimeDirectory = vi.fn()
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({
    target: { kind: 'local' },
    settings: null,
    connectionId: null
  }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import {
  fileExplorerEntriesToTreeNodes,
  keepOpenedDirectoryLinks,
  clearFailedOpenedDirectoryLink,
  readFileExplorerDirectory
} from './file-explorer-directory-listing'
import type { DirCache, TreeNode } from './file-explorer-types'

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
  expect(readRuntimeDirectory).toHaveBeenLastCalledWith(expect.anything(), '/w', {})
})

it('forwards the WSL wake flag of a user act to the directory read', async () => {
  readRuntimeDirectory.mockResolvedValueOnce([])
  await readFileExplorerDirectory('wt-1', '/w', '/w', { wakeWslDistro: true })
  expect(readRuntimeDirectory).toHaveBeenLastCalledWith(expect.anything(), '/w', {
    wakeWslDistro: true
  })
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

describe('keepOpenedDirectoryLinks', () => {
  const node = (name: string, overrides: Partial<TreeNode> = {}): TreeNode => ({
    name,
    path: `/w/${name}`,
    relativePath: name,
    isDirectory: false,
    depth: 0,
    operationOwner: { kind: 'local' },
    ...overrides
  })

  it('keeps an opened folder link folder-shaped when the parent re-read lists it as a file', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true }), node('other')]
    const next = [node('linked', { isSymlink: true }), node('other')]
    const kept = keepOpenedDirectoryLinks(previous, next, {
      '/w/linked': { children: [], operationOwner: { kind: 'local' } }
    })
    expect(kept.map((child) => [child.name, child.isDirectory])).toEqual([
      ['linked', true],
      ['other', false]
    ])
  })

  it('lets a link revert once its own listing is no longer cached', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true })]
    const next = [node('linked', { isSymlink: true })]
    expect(keepOpenedDirectoryLinks(previous, next, {})).toBe(next)
  })

  it('never promotes a link that was not opened, or a plain file with the same path', () => {
    const previous = [node('linked', { isSymlink: true }), node('file', { isDirectory: true })]
    const next = [node('linked', { isSymlink: true }), node('file')]
    const cache = { '/w/linked': { children: [] }, '/w/file': { children: [] } }
    expect(keepOpenedDirectoryLinks(previous, next, cache)).toBe(next)
  })

  it('does not restore a deleted link or a link replaced by a regular file', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true })]
    const cache = { '/w/linked': { children: [], operationOwner: { kind: 'local' as const } } }
    expect(keepOpenedDirectoryLinks(previous, [], cache)).toEqual([])
    expect(keepOpenedDirectoryLinks(previous, [node('linked')], cache)[0].isDirectory).toBe(false)
  })

  it('does not reuse a failed or still-unproven child listing', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true })]
    const next = [node('linked', { isSymlink: true })]
    expect(keepOpenedDirectoryLinks(previous, next, { '/w/linked': { children: [] } })).toBe(next)
    expect(
      keepOpenedDirectoryLinks(previous, next, {
        '/w/linked': { children: [], operationOwner: { kind: 'local' }, error: 'Not a directory' }
      })
    ).toBe(next)
  })

  it('does not carry directory classification across operation owners', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true })]
    const localCache = {
      '/w/linked': { children: [], operationOwner: { kind: 'local' as const } }
    }
    const remoteNode = node('linked', {
      isSymlink: true,
      operationOwner: { kind: 'ssh', connectionId: 'server-2' }
    })
    expect(keepOpenedDirectoryLinks(previous, [remoteNode], localCache)[0].isDirectory).toBe(false)
    const next = [node('linked', { isSymlink: true })]
    expect(
      keepOpenedDirectoryLinks(previous, next, {
        '/w/linked': { children: [], operationOwner: remoteNode.operationOwner }
      })
    ).toBe(next)
  })

  it('leaves unrelated unowned links untouched while preserving a known folder', () => {
    const previous = [node('linked', { isSymlink: true, isDirectory: true })]
    const next = [
      node('linked', { isSymlink: true }),
      node('unowned', { isSymlink: true, operationOwner: undefined })
    ]
    const result = keepOpenedDirectoryLinks(previous, next, {
      '/w/linked': { children: [], operationOwner: { kind: 'local' } }
    })
    expect(result.map((child) => child.isDirectory)).toEqual([true, false])
  })
})

describe('clearFailedOpenedDirectoryLink', () => {
  it.each(['/w/link', 'C:\\link'])('drops only inferred folder state for failed %s', (linkPath) => {
    const parentPath = linkPath.startsWith('C:') ? 'C:\\' : '/w'
    const cache: Record<string, DirCache> = {
      [parentPath]: {
        children: [
          {
            name: 'link',
            path: linkPath,
            relativePath: 'link',
            isDirectory: true,
            isSymlink: true,
            isDirectoryFromOpenedLink: true,
            depth: 0
          }
        ]
      }
    }
    expect(
      clearFailedOpenedDirectoryLink(cache, linkPath)[parentPath].children[0].isDirectory
    ).toBe(false)
    cache[parentPath].children[0].isDirectoryFromOpenedLink = false
    expect(clearFailedOpenedDirectoryLink(cache, linkPath)).toBe(cache)
  })
})
