import { beforeEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { assertEditorBufferInvariant } from '../../../editor-buffer-record-lifecycle'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import type { OpenFile } from '../types/open-file'
import { isDetachedEditorBufferId } from './editor-buffer-views'
import { mayRejoinAfterDraftWrite } from './editor-buffer-rejoin'
import { getEditorModelOwnerKey } from '@/components/editor/editor-model-owner'

function tab(id: string, worktreeId: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig-base',
    ...patch
  }
}

const state = () => useAppStore.getState()
const view = (id: string) => state().openFiles.find((file) => file.id === id)
const recordOf = (id: string) => state().editorBufferIdOf[id]
// Why: a rejoin runs on the next microtask, after the caller finishes settling the record.
const settled = () => Promise.resolve()

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' }),
        makeWorktree({ id: 'wt-2', repoId: 'repo-1', path: '/repo', hostId: 'local' })
      ]
    }
  })
})

/** A restored divergent pair: `a` holds "abc", `b` holds "abcd" and is detached. */
function divergentPair(bPatch: Partial<OpenFile> = {}): void {
  useAppStore.setState({
    openFiles: [
      tab('a', 'wt-1', { isDirty: true }),
      tab('b', 'wt-2', { isDirty: true, ...bPatch })
    ],
    editorDrafts: { a: 'abc', b: 'abcd' }
  })
  expect(isDetachedEditorBufferId(recordOf('b'))).toBe(true)
}

describe('detached records rejoin once one side is clean', () => {
  it('stay apart while both sides hold unsaved edits', async () => {
    divergentPair()
    state().setEditorDraft('a', 'abcX')
    await settled()
    expect(recordOf('b')).not.toBe(recordOf('a'))
    expect(state().editorDrafts.b).toBe('abcd')
  })

  it('the partner saving rejoins: the dirty side wins with its own draft and old baseline', async () => {
    divergentPair()
    // As a written save settles: new baseline, clean, draft cleared.
    state().setLastKnownDiskSignature('a', 'sig-abc')
    state().markFileDirty('a', false)
    state().clearEditorDraft('a')
    expect(recordOf('b')).not.toBe(recordOf('a'))
    await settled()

    expect(recordOf('b')).toBe(recordOf('a'))
    expect(state().editorBufferDetached).toEqual({})
    for (const id of ['a', 'b']) {
      expect(state().editorDrafts[id]).toBe('abcd')
      expect(view(id)?.isDirty).toBe(true)
      // Why the old baseline: the next save is refused and raises the banner on every view.
      expect(view(id)?.lastKnownDiskSignature).toBe('sig-base')
    }
    expect(() => assertEditorBufferInvariant(state())).not.toThrow()
  })

  it('the detached side discarding rejoins as a clean view of the partner', async () => {
    divergentPair()
    state().markFileDirty('b', false)
    state().clearEditorDraft('b')
    await settled()

    expect(recordOf('b')).toBe(recordOf('a'))
    expect(state().editorDrafts.b).toBe('abc')
    expect(view('b')?.isDirty).toBe(true)
  })

  it("carries the detached side's conflict banner onto every view when it wins", async () => {
    divergentPair({ externalMutation: 'changed' })
    state().markFileDirty('a', false)
    state().clearEditorDraft('a')
    await settled()

    expect(view('a')?.externalMutation).toBe('changed')
    expect(view('b')?.externalMutation).toBe('changed')
  })

  it('typing on either side schedules no rejoin pass', async () => {
    divergentPair()
    const revision = state().editorBufferIdentityRevision
    state().setEditorDraft('a', 'abcX')
    state().setEditorDraft('b', 'abcdY')
    await settled()
    expect(state().editorBufferIdentityRevision).toBe(revision)
    // Only clearing a side's draft can make it clean.
    expect(mayRejoinAfterDraftWrite(state(), state().editorBufferDetached, { a: 'x' }, {})).toBe(
      true
    )
    expect(
      mayRejoinAfterDraftWrite(state(), state().editorBufferDetached, { a: 'x' }, { a: 'y' })
    ).toBe(false)
  })

  it('takes the key when the partner closed', async () => {
    divergentPair()
    state().closeFile('a')
    await settled()

    expect(isDetachedEditorBufferId(recordOf('b'))).toBe(false)
    expect(state().editorDrafts.b).toBe('abcd')
  })
})

describe('a dirty record whose last view closed without a prompt', () => {
  function closeWithoutPrompt(ids: string[], notice = 1): void {
    useAppStore.setState((s) => ({
      openFiles: s.openFiles.filter((file) => !ids.includes(file.id)),
      editorBufferKeepRequest: { viewIds: new Set(ids), notice }
    }))
  }

  it('is kept, and reopening the file joins it: draft, dirty flag and baseline', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true, lastKnownDiskSignature: 'sig-old' })],
      editorDrafts: { a: 'kept edits' }
    })
    const recordId = recordOf('a')
    closeWithoutPrompt(['a'])
    expect(Object.keys(state().editorBuffers)).toEqual([])
    expect(state().editorBufferKept[recordId]?.draft).toBe('kept edits')

    useAppStore.setState((s) => ({ openFiles: [...s.openFiles, tab('b', 'wt-2')] }))
    expect(recordOf('b')).toBe(recordId)
    expect(state().editorDrafts.b).toBe('kept edits')
    expect(view('b')?.isDirty).toBe(true)
    expect(view('b')?.lastKnownDiskSignature).toBe('sig-old')
    expect(state().editorBufferKept).toEqual({})
  })

  it('is not kept when the close asked nothing (Don’t save) or the record was clean', () => {
    useAppStore.setState({
      openFiles: [
        tab('a', 'wt-1', { isDirty: true }),
        tab('c', 'wt-1', { filePath: '/repo/c.ts' })
      ],
      editorDrafts: { a: 'discarded' }
    })
    state().closeFile('a')
    closeWithoutPrompt(['c'])
    expect(state().editorBufferKept).toEqual({})
  })

  it('a divergent dirty view reopening it stays detached, on its own model, until one side is clean', async () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true })],
      editorDrafts: { a: 'kept edits' }
    })
    const recordId = recordOf('a')
    const keptOwner = getEditorModelOwnerKey(view('a')!, state())
    closeWithoutPrompt(['a'])
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('b', 'wt-2', { isDirty: true })],
      editorDrafts: { ...s.editorDrafts, b: 'other edits' }
    }))
    await settled()
    expect(state().editorDrafts.b).toBe('other edits')
    expect(state().editorBufferKept[recordId]?.draft).toBe('kept edits')
    // Not the kept record's id, so not its model address either.
    expect(isDetachedEditorBufferId(recordOf('b'))).toBe(true)
    expect(getEditorModelOwnerKey(view('b')!, state())).not.toBe(keptOwner)

    state().markFileDirty('b', false)
    state().clearEditorDraft('b')
    await settled()
    // Clean, it rejoins: the kept edits win.
    expect(recordOf('b')).toBe(recordId)
    expect(state().editorDrafts.b).toBe('kept edits')
    expect(state().editorBufferKept).toEqual({})
  })

  it('is dropped when a rename moves another file onto its path', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true })],
      editorDrafts: { a: 'kept edits' }
    })
    const recordId = recordOf('a')
    closeWithoutPrompt(['a'])
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('/repo/z.ts', 'wt-1', { filePath: '/repo/z.ts' })]
    }))
    state().rekeyOpenFilesForPathChange({
      rekeys: [
        {
          oldFileId: '/repo/z.ts',
          newFileId: '/repo/a.ts',
          oldFilePath: '/repo/z.ts',
          newFilePath: '/repo/a.ts',
          newRelativePath: 'a.ts'
        }
      ]
    })
    expect(recordOf('/repo/a.ts')).toBe(recordId)
    expect(state().editorDrafts['/repo/a.ts']).toBeUndefined()
    expect(view('/repo/a.ts')?.isDirty).toBe(false)
    expect(state().editorBufferKept).toEqual({})
  })

  it('is dropped when its own removal notice goes away, not when an older one does', () => {
    useAppStore.setState({
      openFiles: [tab('a', 'wt-1', { isDirty: true })],
      editorDrafts: { a: 'kept edits' }
    })
    closeWithoutPrompt(['a'], 2)
    state().releaseKeptEditorBuffers(1)
    expect(Object.keys(state().editorBufferKept)).toHaveLength(1)
    state().releaseKeptEditorBuffers(2)
    expect(state().editorBufferKept).toEqual({})
  })
})
