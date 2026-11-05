import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'

import type { OpenFile } from '../types/open-file'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

const state = () => useAppStore.getState()
const view = (id: string) => state().openFiles.find((file) => file.id === id)
const recordOf = (id: string) => state().editorBufferIdOf[id]

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
})

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
})

describe('a retired runtime', () => {
  const runtimeTab = (id: string, patch: Partial<OpenFile> = {}) =>
    tab(id, { runtimeEnvironmentId: 'env', worktreeId: `wt-${id}`, ...patch })
  const retire = () =>
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 2 }], {
      retired: ['env'],
      sameHost: []
    })

  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env', createdAt: 0, pairingRevision: 1 }])
  })

  it("quarantines the old machine's views with their draft, apart from the replacement", () => {
    useAppStore.setState({
      openFiles: [runtimeTab('old1', { isDirty: true }), runtimeTab('old2', { isDirty: true })],
      editorDrafts: { old1: 'old edits', old2: 'old edits' }
    })
    expect(recordOf('old1')).toBe(recordOf('old2'))
    retire()

    // Every view of the record moves to one kept record.
    expect(recordOf('old1')).toBe('detached:old1')
    expect(recordOf('old2')).toBe('detached:old1')
    expect(state().editorBufferDetached.old2?.retired).toBe(true)

    useAppStore.setState((s) => ({ openFiles: [...s.openFiles, runtimeTab('new')] }))
    expect(recordOf('new')).not.toBe(recordOf('old1'))
    expect(view('new')?.isDirty).toBe(false)
    expect(state().editorDrafts.new).toBeUndefined()
    expect(view('old1')?.isDirty).toBe(true)
    expect(state().editorDrafts.old2).toBe('old edits')
    expect(() => assertEditorBufferInvariant(state())).not.toThrow()
  })
})

describe('SSH identity through the record index', () => {
  const sshTab = (id: string, patch: Partial<OpenFile> = {}) =>
    tab(id, { externalSshTargetId: 'target', worktreeId: `wt-${id}`, ...patch })

  it('two workspaces on one runtime-in-SSH file share a record, and its edits', () => {
    useAppStore.setState({
      openFiles: [
        sshTab('w1', { runtimeEnvironmentId: 'env' }),
        sshTab('w2', { runtimeEnvironmentId: 'env' })
      ]
    })
    expect(recordOf('w1')).toBe(recordOf('w2'))

    state().setEditorDraft('w1', 'edits')
    state().markFileDirty('w1', true)
    expect(view('w2')?.isDirty).toBe(true)
    expect(state().editorDrafts.w2).toBe('edits')
  })
})
