import { describe, expect, it, vi } from 'vitest'

const readRuntimeDirectory = vi.fn()
vi.mock('@/runtime/runtime-file-mutation-client', () => ({
  readRuntimeDirectory: (...args: unknown[]) => readRuntimeDirectory(...args)
}))
vi.mock('../navigation/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({ kind: 'local' }),
  getFileExplorerOperationRoute: () => ({
    target: { kind: 'local' },
    settings: null,
    connectionId: null
  }),
  getFileExplorerOwnerUnresolvedMessage: () => 'unresolved'
}))

import { keepOpenedDirectoryLinks } from './file-explorer-directory-listing'

import type { TreeNode } from './file-explorer-types'

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
