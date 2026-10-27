import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { applyRemoveWorktreeSuccessState } from './remove-worktree-store-cleanup'
import { noticeRemovedUnsavedFiles } from './removed-workspace-unsaved-files'

const show = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/closed-unsaved-files-toast', () => ({
  showClosedUnsavedFilesToast: show
}))

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

beforeEach(() => {
  show.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { api: { pty: { kill: vi.fn() } } })
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
afterEach(() => vi.unstubAllGlobals())

it('removing one workspace keeps the shared record, its draft and its key in the other', async () => {
  useAppStore.setState({
    openFiles: [tab('a', 'wt-1', { isDirty: true }), tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { a: 'shared edits', b: 'shared edits' }
  })
  const recordId = state().editorBufferIdOf.a
  expect(state().editorBufferIdOf.b).toBe(recordId)

  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  await Promise.resolve()

  expect(state().openFiles.map((file) => file.id)).toEqual(['a'])
  // Same record id: the autosave timer and queued save keyed by it carry on.
  expect(state().editorBufferIdOf.a).toBe(recordId)
  expect(state().editorBufferViews[recordId]).toEqual(['a'])
  expect(state().editorDrafts.a).toBe('shared edits')
  expect(state().openFiles[0]?.isDirty).toBe(true)
  expect(state().editorBufferKept).toEqual({})
  expect(show).not.toHaveBeenCalled()
})

it("a removal with no prompt keeps the last view's dirty record; reopening the file joins it", async () => {
  useAppStore.setState({
    openFiles: [tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { b: 'only copy' }
  })
  const recordId = state().editorBufferIdOf.b

  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  expect(state().openFiles).toEqual([])
  expect(state().editorBufferKept[recordId]?.draft).toBe('only copy')

  useAppStore.setState({ openFiles: [tab('a', 'wt-1')] })
  expect(state().editorBufferIdOf.a).toBe(recordId)
  expect(state().editorDrafts.a).toBe('only copy')
  expect(state().openFiles[0]?.isDirty).toBe(true)
})

it('a confirmed removal discards: nothing is kept', () => {
  useAppStore.setState({
    openFiles: [tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { b: 'listed and confirmed' }
  })
  applyRemoveWorktreeSuccessState(
    useAppStore.setState,
    'wt-2',
    new Set(),
    'local',
    new Map([['b', 'listed and confirmed']])
  )
  expect(state().editorBufferKept).toEqual({})
})

it('a removal closing tabs over several writes keeps every dirty record it closes', async () => {
  useAppStore.setState({
    openFiles: [
      tab('x', 'wt-1', { filePath: '/repo/x.ts', isDirty: true }),
      tab('y', 'wt-2', { filePath: '/repo/y.ts', isDirty: true }),
      tab('z', 'wt-1', { filePath: '/repo/z.ts' })
    ],
    editorDrafts: { x: 'x edits', y: 'y edits' }
  })
  const [xRecord, yRecord] = [state().editorBufferIdOf.x, state().editorBufferIdOf.y]

  // Simulate project batch removal: notice first, close twin separately, reconcile unrelated write, then purge the rest.
  const keep = noticeRemovedUnsavedFiles(state(), new Set(['x', 'y']))
  state().closeFile('x', { captureRecentlyClosed: false, keepEditorBuffer: keep })
  state().closeFile('z')
  state().purgeWorktreeTerminalState(['wt-2'])
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))

  expect(state().openFiles).toEqual([])
  expect(state().editorBufferKept[xRecord]?.draft).toBe('x edits')
  expect(state().editorBufferKept[yRecord]?.draft).toBe('y edits')
  // Dismissing the notice releases both.
  state().releaseKeptEditorBuffers(show.mock.calls[0][2])
  expect(state().editorBufferKept).toEqual({})
})

it('releases the kept records when the notice cannot be shown', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  show.mockImplementationOnce(() => {
    throw new Error('toast failed')
  })
  useAppStore.setState({
    openFiles: [tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { b: 'only copy' }
  })
  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  expect(Object.keys(state().editorBufferKept)).toHaveLength(1)
  await vi.waitFor(() => expect(state().editorBufferKept).toEqual({}))
})

it('dismissing one notice leaves the records a newer notice kept for the same file', async () => {
  useAppStore.setState({
    openFiles: [tab('b', 'wt-2', { isDirty: true })],
    editorDrafts: { b: 'first' }
  })
  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-2', new Set(), 'local')
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1))
  // The same tab id reopened elsewhere with different text, then removed again.
  useAppStore.setState((s) => ({
    openFiles: [tab('b', 'wt-1', { isDirty: true })],
    editorDrafts: { ...s.editorDrafts, b: 'second' }
  }))
  applyRemoveWorktreeSuccessState(useAppStore.setState, 'wt-1', new Set(), 'local')
  await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2))

  state().releaseKeptEditorBuffers(show.mock.calls[0][2])
  expect(Object.values(state().editorBufferKept).map((entry) => entry.draft)).toEqual(['second'])
})
