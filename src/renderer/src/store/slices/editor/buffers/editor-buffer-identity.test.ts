import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import {
  onRuntimeEnvironmentsRetired,
  replaceRuntimeEnvironmentRevisions
} from '@/runtime/runtime-environment-revision'
import {
  detachedEditorBufferId,
  editorBufferIdentityOf,
  editorBufferPathKey,
  isEditorBufferIdentityRetired
} from './editor-buffer-identity'

const LOCAL: WorktreeOperationRoute = { executionHostId: 'local', runtimeEnvironmentId: null }

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
  it('gives one local file in two workspaces one key', () => {
    expect(keyOf(file({}, LOCAL))).toBe(keyOf(file({ id: 'b', worktreeId: 'wt-2' }, LOCAL)))
  })

  it('keeps WSL aliases apart on a local Windows client', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' })
    const wslDollar = file({ filePath: '\\\\wsl$\\Ubuntu\\home\\a.ts' }, LOCAL)
    const wslLocalhost = file({ id: 'b', filePath: '\\\\wsl.localhost\\Ubuntu\\home\\a.ts' }, LOCAL)
    expect(keyOf(wslDollar)).not.toBe(keyOf(wslLocalhost))
  })

  it('keys an SSH file by its connection target and runtime environment', () => {
    const direct = keyOf(file({ externalSshTargetId: 'target', runtimeEnvironmentId: null }))
    const directElsewhere = keyOf(
      file({ id: 'b', worktreeId: 'wt-2', externalSshTargetId: 'target' })
    )
    const otherTarget = keyOf(file({ externalSshTargetId: 'target-2' }))
    const nested = keyOf(file({ externalSshTargetId: 'target', runtimeEnvironmentId: 'env' }))
    const nestedElsewhere = keyOf(
      file({
        id: 'b',
        worktreeId: 'wt-2',
        externalSshTargetId: 'target',
        runtimeEnvironmentId: 'env'
      })
    )
    const otherRuntime = keyOf(
      file({ externalSshTargetId: 'target', runtimeEnvironmentId: 'env-2' })
    )

    expect(direct).toBeDefined()
    expect(direct).toBe(directElsewhere)
    expect(new Set([direct, otherTarget, nested, otherRuntime]).size).toBe(4)
    expect(nested).toBe(nestedElsewhere)
  })

  it('keeps a remote forward-slash UNC path apart from its backslash form', () => {
    const route: WorktreeOperationRoute = {
      executionHostId: 'runtime:env',
      runtimeEnvironmentId: 'env'
    }
    const slash = file({ filePath: '//SERVER/share/a.ts' }, route)
    const backslash = file({ id: 'b', filePath: '\\\\SERVER\\share\\a.ts' }, route)
    expect(keyOf(slash)).not.toBe(keyOf(backslash))
  })

  it('keeps a runtime host and the local machine apart for one path', () => {
    expect(keyOf(file({}, LOCAL))).not.toBe(keyOf(runtimeTab('b')))
  })

  it('never shares a tab whose owner is unresolved, or a non-edit tab', () => {
    expect(editorBufferIdentityOf(file({ runtimeEnvironmentId: null }), {})).toBeNull()
    expect(editorBufferIdentityOf(file({ mode: 'diff' }, LOCAL), {})).toBeNull()
  })

  it('joins a re-pair proven to be the same machine', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: [],
      sameHost: [{ id: 'env', fromRevision: 1, toRevision: 2 }]
    })
    expect(keyOf(runtimeTab('old', 1))).toBe(keyOf(runtimeTab('new', 2)))
    expect(keyOf(runtimeTab('old', 1))).toBe(keyOf(runtimeTab('unpinned')))
  })

  it('keeps a pairing apart from an unproven re-pair', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: [],
      sameHost: [],
      pending: [{ id: 'env', fromRevision: 1 }]
    })
    expect(keyOf(runtimeTab('old', 1))).not.toBe(keyOf(runtimeTab('new', 2)))
  })

  it('quarantines a retired host: its replacement with the same path stays apart', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    const old = runtimeTab('old')
    const local = editorBufferIdentityOf(file({}, LOCAL), {})
    const quarantine = new Map<string, string>()
    // Retirement fires before the new revision is published, while the old key still stands.
    const stop = onRuntimeEnvironmentsRetired((retired) => {
      for (const [viewId, identity] of [
        ['old', editorBufferIdentityOf(old, {})],
        ['local', local]
      ] as const) {
        if (identity && isEditorBufferIdentityRetired(identity, retired)) {
          quarantine.set(viewId, detachedEditorBufferId(viewId))
        }
      }
    })
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: ['env'],
      sameHost: []
    })
    stop()

    // An unpinned tab re-resolves to the replacement: its key alone can't tell the machines apart.
    const replacementKey = keyOf(runtimeTab('new'))
    expect(keyOf(old)).toBe(replacementKey)
    expect([...quarantine]).toEqual([['old', 'detached:old']])
    expect(quarantine.get('old')).not.toBe(replacementKey)
    expect(detachedEditorBufferId('old')).not.toBe(detachedEditorBufferId('new'))
  })

  it('resolves an unpinned tab live, so its key moves once revisions load', () => {
    const unpinned = runtimeTab('a')
    const beforeLoad = keyOf(unpinned)
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    expect(keyOf(unpinned)).not.toBe(beforeLoad)
    expect(keyOf(unpinned)).toBe(keyOf(runtimeTab('pinned', 1)))
  })

  it('keeps a pinned tab of a retired pairing apart from the replacement', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: ['env'],
      sameHost: []
    })
    expect(keyOf(runtimeTab('old', 1))).not.toBe(keyOf(runtimeTab('new')))
  })
})
