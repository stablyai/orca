import { afterEach, describe, expect, it } from 'vitest'
import type { OpenFile } from '../types/open-file'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { toEditorModelUri } from '@/components/editor/editor-model-uri'
import {
  editorBufferIdentityOf,
  editorBufferPathKey,
  isSameEditorBuffer,
  type EditorBufferIdentity
} from './editor-buffer-identity'
import { EMPTY_EDITOR_BUFFER_INDEX } from './editor-buffer-record'
import { reconcileEditorBufferSharing } from './editor-buffer-sharing'

function file(overrides: Partial<OpenFile>): OpenFile {
  return {
    id: 'a',
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig-disk',
    ...overrides
  }
}

function identity(revision: number | undefined): EditorBufferIdentity {
  return {
    key: JSON.stringify(['env', 'runtime:env', '/repo/a.ts']),
    environmentId: 'env',
    revision,
    modelOwnerKey: JSON.stringify(['env', 'runtime:env'])
  }
}

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

describe('editor buffer identity', () => {
  it.each([
    ['\\\\wsl$\\Ubuntu\\home\\me\\a.ts', '\\\\wsl.localhost\\ubuntu\\home\\me\\a.ts'],
    ['//wsl$/Ubuntu/home/me/a.ts', '\\\\wsl.localhost\\Ubuntu\\home\\me\\a.ts'],
    ['C:\\Repo\\A.ts', 'c:/Repo/A.ts']
  ])('treats %s and %s as one file', (left, right) => {
    expect(editorBufferPathKey(left)).toBe(editorBufferPathKey(right))
  })

  it('gives both WSL aliases one text model', () => {
    expect(toEditorModelUri('//wsl$/Ubuntu/home/me/a.ts')).toBe(
      toEditorModelUri('//wsl.localhost/ubuntu/home/me/a.ts')
    )
  })

  it.each([
    ['C:/Repo/A.ts', 'C:/repo/a.ts'],
    ['//wsl$/Ubuntu/home/me/A.ts', '//wsl$/Ubuntu/home/me/a.ts'],
    ['/repo/A.ts', '/repo/a.ts'],
    ['/repo/a\\b.ts', '/repo/a/b.ts']
  ])('keeps case and POSIX backslashes exact: %s is not %s', (left, right) => {
    expect(editorBufferPathKey(left)).not.toBe(editorBufferPathKey(right))
  })

  it('keys an SSH target by its runtime namespace as well as its target id', () => {
    const direct = editorBufferIdentityOf(
      file({ externalSshTargetId: 'target', runtimeEnvironmentId: null }),
      {}
    )
    const nested = editorBufferIdentityOf(
      file({ externalSshTargetId: 'target', runtimeEnvironmentId: 'env' }),
      {}
    )
    const again = editorBufferIdentityOf(
      file({
        id: 'b',
        worktreeId: 'wt-2',
        externalSshTargetId: 'target',
        runtimeEnvironmentId: 'env'
      }),
      {}
    )

    expect(direct?.key).not.toBe(nested?.key)
    expect(nested?.key).toBe(again?.key)
  })

  it('never shares a tab whose owner is unresolved, or a non-edit tab', () => {
    expect(editorBufferIdentityOf(file({}), {})).toBeNull()
    expect(
      editorBufferIdentityOf(file({ mode: 'diff', runtimeEnvironmentId: null }), {})
    ).toBeNull()
  })

  it('joins a re-pair proven to be the same machine, never a retired one', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: [],
      sameHost: [{ id: 'env', fromRevision: 1, toRevision: 2 }]
    })
    expect(isSameEditorBuffer(identity(1), identity(2))).toBe(true)

    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 3 }], {
      retired: ['env'],
      sameHost: []
    })
    expect(isSameEditorBuffer(identity(2), identity(3))).toBe(false)
  })

  it('quarantines a retired host: its replacement with the same path and baseline stays apart', () => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
    const old = file({ id: 'old', isDirty: true, runtimeEnvironmentId: 'env' })
    const first = reconcileEditorBufferSharing({
      openFiles: [old],
      records: {},
      index: EMPTY_EDITOR_BUFFER_INDEX,
      drafts: { old: 'edit on the old machine' },
      previousRecords: {},
      previousFiles: null,
      identityOf: () => identity(1),
      onMirrorDrift: () => {},
      draftPreference: () => 0,
      now: () => 0
    })
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: ['env'],
      sameHost: []
    })

    const replacement = file({ id: 'new', runtimeEnvironmentId: 'env' })
    const next = reconcileEditorBufferSharing({
      openFiles: [old, replacement],
      records: first.records,
      index: first.index,
      drafts: first.drafts,
      previousRecords: first.records,
      previousFiles: new Map([['old', old]]),
      identityOf: (tab) => identity(tab.id === 'old' ? 1 : 2),
      onMirrorDrift: () => {},
      draftPreference: () => 0,
      now: () => 0
    })

    const oldRecord = next.index.recordIdByFileId.old
    const newRecord = next.index.recordIdByFileId.new
    expect(oldRecord).not.toBe(newRecord)
    expect(next.index.keyByRecordId[newRecord].modelOwnerKey).not.toBe(
      next.index.keyByRecordId[oldRecord].modelOwnerKey
    )
    expect(next.drafts).toEqual({ old: 'edit on the old machine' })
    expect(next.openFiles.find((tab) => tab.id === 'new')?.isDirty).toBe(false)
  })
})
