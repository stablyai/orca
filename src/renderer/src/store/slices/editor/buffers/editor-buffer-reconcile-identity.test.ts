import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import type { OpenFile } from '../types/open-file'
import type * as identityModule from './editor-buffer-identity'
import { editorBufferIdentityOf } from './editor-buffer-identity'

// Counts identity resolutions, so the scale test can prove the index never re-resolves per keystroke.
vi.mock('./editor-buffer-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof identityModule>()
  return { ...actual, editorBufferIdentityOf: vi.fn(actual.editorBufferIdentityOf) }
})

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
  vi.mocked(editorBufferIdentityOf).mockClear()
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

  it('never merges, even with an identical draft or a later route change', () => {
    useAppStore.setState({
      openFiles: [runtimeTab('old', { isDirty: true })],
      editorDrafts: { old: 'same' }
    })
    retire()
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, runtimeTab('new', { isDirty: true })],
      editorDrafts: { ...s.editorDrafts, new: 'same' }
    }))
    state().reconcileEditorBufferIdentities()
    useAppStore.setState({ repos: [] })

    expect(recordOf('old')).toBe('detached:old')
    expect(recordOf('new')).not.toBe('detached:old')
    expect(state().editorBufferViews[recordOf('new')]).toEqual(['new'])
  })

  it('a view of another environment is left alone', () => {
    useAppStore.setState({
      openFiles: [runtimeTab('other', { runtimeEnvironmentId: 'env-2', isDirty: true })],
      editorDrafts: { other: 'edits' }
    })
    const before = recordOf('other')
    retire()
    expect(recordOf('other')).toBe(before)
    expect(state().editorBufferDetached).toEqual({})
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

  it('keeps direct SSH, another target and another runtime on the target apart', () => {
    useAppStore.setState({
      openFiles: [
        sshTab('nested', { runtimeEnvironmentId: 'env' }),
        sshTab('direct', { runtimeEnvironmentId: null }),
        sshTab('other-target', { externalSshTargetId: 'target-2', runtimeEnvironmentId: 'env' }),
        sshTab('other-runtime', { runtimeEnvironmentId: 'env-2' })
      ]
    })
    const records = ['nested', 'direct', 'other-target', 'other-runtime'].map(recordOf)
    expect(new Set(records).size).toBe(4)
    expect(() => assertEditorBufferInvariant(state())).not.toThrow()
  })

  it('keeps an SSH file apart from the local file with the same path', () => {
    useAppStore.setState({
      worktreesByRepo: {
        'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
      },
      openFiles: [tab('local'), sshTab('remote', { runtimeEnvironmentId: null })]
    })
    expect(recordOf('local')).not.toBe(recordOf('remote'))
  })
})

describe('scale', () => {
  const FILES = 20
  const WORKSPACES = 10

  it('indexes 200 tabs across 20 files with one resolution per tab, and none per keystroke', () => {
    const worktrees = Array.from({ length: WORKSPACES }, (_, w) =>
      makeWorktree({ id: `wt-${w}`, repoId: 'repo-1', path: '/repo', hostId: 'local' })
    )
    const tabs = Array.from({ length: FILES * WORKSPACES }, (_, i) => {
      const file = i % FILES
      return tab(`t${i}`, {
        filePath: `/repo/f${file}.ts`,
        relativePath: `f${file}.ts`,
        worktreeId: `wt-${Math.floor(i / FILES)}`
      })
    })
    const resolutions = vi.mocked(editorBufferIdentityOf)
    useAppStore.setState({ worktreesByRepo: { 'repo-1': worktrees } })
    resolutions.mockClear()

    expect(() => useAppStore.setState({ openFiles: tabs })).not.toThrow()
    expect(resolutions).toHaveBeenCalledTimes(tabs.length)
    expect(Object.keys(state().editorBuffers)).toHaveLength(FILES)
    for (const viewIds of Object.values(state().editorBufferViews)) {
      expect(viewIds).toHaveLength(WORKSPACES)
    }
    expect(() => assertEditorBufferInvariant(state())).not.toThrow()

    // Going dirty rewrites only the record's own views.
    resolutions.mockClear()
    state().setEditorDraft('t0', 'e')
    state().markFileDirty('t0', true)
    expect(resolutions).toHaveBeenCalledTimes(WORKSPACES)
    resolutions.mockClear()
    state().setEditorDraft('t0', 'edits')
    expect(resolutions).not.toHaveBeenCalled()
    const dirty = state().openFiles.filter((file) => file.isDirty)
    expect(dirty.map((file) => file.id)).toEqual(
      Array.from({ length: WORKSPACES }, (_, w) => `t${w * FILES}`)
    )

    // One more tab resolves only itself.
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('late', { worktreeId: 'wt-3', filePath: '/repo/f0.ts' })]
    }))
    expect(resolutions).toHaveBeenCalledTimes(1)
    expect(recordOf('late')).toBe(recordOf('t0'))
    expect(view('late')?.isDirty).toBe(true)

    // A route change re-resolves each tab once.
    resolutions.mockClear()
    state().reconcileEditorBufferIdentities()
    expect(resolutions).toHaveBeenCalledTimes(tabs.length + 1)
  })
})
