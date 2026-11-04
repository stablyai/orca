import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import './editor-buffer-views'
import { editorBufferIdentityOf, editorBufferPathKey } from './editor-buffer-identity'

function file(overrides: Partial<OpenFile> = {}, route?: WorktreeOperationRoute): OpenFile {
  return {
    id: 'a',
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...(route
      ? {
          runtimeEnvironmentId: route.runtimeEnvironmentId,
          operationProvenance: {
            ownershipProjection: 'explicit' as const,
            generation: {
              route,
              runtimeConnectionGeneration: null,
              runtimePairingRevision: undefined,
              runtimeSshGeneration: null,
              nestedSshGeneration: null,
              directSshGeneration: null
            }
          }
        }
      : {}),
    ...overrides
  }
}

function keyOf(tab: OpenFile): string | undefined {
  return editorBufferIdentityOf(tab, {})?.key
}

function pathKey(filePath: string, windows = false) {
  return editorBufferPathKey(filePath, windows)
}

function runtimeTab(id: string, pairingRevision?: number): OpenFile {
  const tab = file({ id, runtimeEnvironmentId: 'env' })
  return pairingRevision === undefined
    ? tab
    : file(
        {
          id,
          operationProvenance: {
            ownershipProjection: 'explicit',
            generation: {
              route: { executionHostId: 'runtime:env', runtimeEnvironmentId: 'env' },
              runtimeConnectionGeneration: null,
              runtimePairingRevision: pairingRevision,
              runtimeSshGeneration: null,
              nestedSshGeneration: null,
              directSshGeneration: null
            }
          }
        },
        { executionHostId: 'runtime:env', runtimeEnvironmentId: 'env' }
      )
}

afterEach(() => {
  vi.unstubAllGlobals()
  replaceRuntimeEnvironmentRevisions([])
})

describe('editorBufferPathKey', () => {
  it.each([
    ['C:\\Repo\\A.ts', 'c:/Repo/A.ts'],
    ['C:/Repo//A.ts', 'c:\\Repo\\A.ts'],
    ['\\\\server\\share\\A.ts', '\\\\SERVER\\share\\A.ts']
  ])('treats %s and %s as one file on any host', (left, right) => {
    expect(pathKey(left)).toBe(pathKey(right))
  })

  it('folds the UNC server name of a forward-slash path on a Windows client only', () => {
    expect(pathKey('//SERVER/share/a.ts', true)).toBe(pathKey('//server/share/a.ts', true))
    expect(pathKey('\\\\server\\share\\a.ts', true)).toBe(pathKey('//SERVER/share/a.ts', true))
  })

  it.each([
    ['C:/Repo/A.ts', 'C:/repo/a.ts'],
    ['\\\\server\\share\\A.ts', '\\\\server\\share\\a.ts'],
    ['\\\\server\\Share\\a.ts', '\\\\server\\share\\a.ts'],
    ['\\\\wsl$\\Ubuntu\\home\\me\\a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts'],
    ['/repo/A.ts', '/repo/a.ts'],
    ['/repo/a\\b.ts', '/repo/a/b.ts']
  ])('never folds path case, WSL aliases or POSIX backslashes: %s is not %s', (left, right) => {
    expect(pathKey(left, true)).not.toBe(pathKey(right, true))
  })

  it('keeps an ambiguous `//` path exact unless the client is Windows', () => {
    // Valid POSIX names on Linux or an SSH host: a backslash is part of the file name.
    expect(pathKey('//repo/a\\b.ts')).not.toBe(pathKey('//repo/a/b.ts'))
    expect(pathKey('//SERVER/share/a.ts')).not.toBe(pathKey('//server/share/a.ts'))
    expect(pathKey('//repo/a\\b.ts', true)).toBe(pathKey('//repo/a/b.ts', true))
  })
})

describe('editorBufferIdentityOf', () => {
  it('joins a re-pair proven to be the same machine', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: [],
      sameHost: [{ id: 'env', fromRevision: 1, toRevision: 2 }]
    })
    expect(keyOf(runtimeTab('old', 1))).toBe(keyOf(runtimeTab('new', 2)))
    expect(keyOf(runtimeTab('old', 1))).toBe(keyOf(runtimeTab('unpinned')))
  })
})
