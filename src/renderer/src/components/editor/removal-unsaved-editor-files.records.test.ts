import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { lastViewUnsavedFiles } from './removal-unsaved-editor-files'

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: true,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

it('through the real identity index, skips a file whose record keeps a view open', () => {
  useAppStore.setState({ openFiles: [tab('a')], editorDrafts: { a: 'edits' } })
  useAppStore.setState((s) => ({
    openFiles: [...s.openFiles, tab('b')],
    editorDrafts: { ...s.editorDrafts, b: 'edits' }
  }))
  const state = useAppStore.getState()
  expect(state.editorBufferIdOf.a).toBe(state.editorBufferIdOf.b)

  expect(lastViewUnsavedFiles(state, new Set(['a']))).toEqual([])
  expect(lastViewUnsavedFiles(state, new Set(['a', 'b']))).toHaveLength(1)
})

it('preserves first eligible output, empty drafts, preview eligibility and fresh changed closure', () => {
  const files = [
    tab('readonly', { readOnly: true, isDirty: false }),
    tab('eligible', { isPreview: true, isDirty: false })
  ]
  useAppStore.setState({
    openFiles: files,
    settings: { ...useAppStore.getState().settings!, editorAutoSave: false }
  })
  useAppStore.getState().markFileDirty('eligible', true)
  const state = useAppStore.getState()
  expect(state.editorBufferIdOf.readonly).toBe(state.editorBufferIdOf.eligible)
  expect(lastViewUnsavedFiles(state, new Set(['readonly', 'eligible']))).toEqual([
    state.openFiles[1]
  ])
  const preview = { ...state.openFiles[1], isPreview: true }
  expect(preview.isDirty).toBe(true)
  expect(
    lastViewUnsavedFiles(
      { ...state, openFiles: [state.openFiles[0], preview] },
      new Set(['readonly', 'eligible'])
    )[0]
  ).toBe(preview)
  expect(lastViewUnsavedFiles(state, new Set(['eligible']))).toEqual([])
  expect(lastViewUnsavedFiles(state, new Set(['readonly', 'eligible']))).toEqual([
    state.openFiles[1]
  ])
  useAppStore.setState({
    openFiles: [
      tab('empty', { isDirty: false }),
      tab('clean', { filePath: '/repo/clean.ts', isDirty: false })
    ],
    editorDrafts: { empty: '' }
  })
  const drafted = useAppStore.getState()
  expect(lastViewUnsavedFiles(drafted, new Set(['empty', 'clean']))).toEqual([drafted.openFiles[0]])
  useAppStore.getState().clearEditorDraft('empty')
  expect(lastViewUnsavedFiles(useAppStore.getState(), new Set(['empty', 'clean']))).toEqual([])
})

it('retains actual detached, mirrored and unresolved records plus singleton/index fallbacks', () => {
  useAppStore.setState({
    openFiles: [tab('left'), tab('right')],
    editorDrafts: { left: 'left text', right: 'right text' }
  })
  const detached = useAppStore.getState()
  expect(detached.editorBufferIdOf.left).not.toBe(detached.editorBufferIdOf.right)
  expect(lastViewUnsavedFiles(detached, new Set(['left', 'right']))).toEqual(detached.openFiles)
  expect(lastViewUnsavedFiles(detached, new Set(['left']))).toEqual([detached.openFiles[0]])
  const retiredEntry = Object.entries(detached.editorBufferDetached)[0]
  expect(retiredEntry).toBeDefined()
  if (!retiredEntry) {
    throw new Error('divergent drafts must have an actual detached record')
  }
  const [retiredView, detachment] = retiredEntry
  useAppStore.setState({
    editorBufferDetached: {
      ...detached.editorBufferDetached,
      [retiredView]: { ...detachment, retired: true }
    }
  })
  const retired = useAppStore.getState()
  expect(retired.editorBufferDetached[retiredView].retired).toBe(true)
  expect(retired.editorBufferIdOf[retiredView]).toBe(detachment.recordId)
  expect(lastViewUnsavedFiles(retired, new Set(['left', 'right']))).toEqual(retired.openFiles)
  useAppStore.setState({
    openFiles: [
      tab('ordinary'),
      tab('mirror', { mirroredFromRuntimeSession: true }),
      tab('unknown', { worktreeId: 'unknown-owner' }),
      tab('foreign', { externalSshTargetId: 'other' })
    ],
    editorDrafts: {}
  })
  const current = useAppStore.getState()
  expect(new Set(current.openFiles.map((file) => current.editorBufferIdOf[file.id])).size).toBe(4)
  const closed = new Set(current.openFiles.map((file) => file.id))
  expect(lastViewUnsavedFiles(current, closed)).toEqual(current.openFiles)
  expect(
    lastViewUnsavedFiles({ ...current, editorBufferIdOf: {}, editorBufferViews: {} }, closed)
  ).toEqual(current.openFiles)
  expect(lastViewUnsavedFiles({ ...current, editorBufferViews: {} }, closed)).toEqual(
    current.openFiles.filter((file) => closed.has(current.editorBufferIdOf[file.id]))
  )
})
