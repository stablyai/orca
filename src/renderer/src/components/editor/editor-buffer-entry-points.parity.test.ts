import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { needsSavePromptOnClose } from '@/store/slices/editor/buffers/editor-buffer-close-rule'
import type { EditorBufferViewIndex } from '@/store/slices/editor/buffers/editor-buffer-views'
import { restartSaveTargets } from './editor-autosave-state-projections'
import { EDITOR_SAVE_KEYS } from './editor-save-queue'
import { editorTabModelUri } from './editor-save-disk-precondition'
import {
  flushPendingEditorBuffer,
  hasPendingEditorBufferChange,
  registerPendingEditorFlush
} from './editor-pending-flush'
import { discardEditorFileChangesAndClose } from './discard-editor-file-changes'
import type * as EditorAutosave from './editor-autosave'

const quiesce = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<typeof EditorAutosave>()),
  requestEditorSaveQuiesce: quiesce
}))

function tab(id: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath: '/repo/a.ts',
    relativePath: 'a.ts',
    worktreeId: 'wt-1',
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...patch
  }
}

// The cases whose old answers differ: one model shared across workspaces, a clean tab, a non-edit tab.
const FIXTURE: OpenFile[] = [
  tab('/repo/a.ts', { isDirty: true }),
  tab('editor:wt-2:local:/repo/a.ts', { worktreeId: 'wt-2', isDirty: true }),
  tab('/repo/b.md', { filePath: '/repo/b.md', language: 'markdown' }),
  tab('wt-1::diff::unstaged::a.ts', { mode: 'diff', diffSource: 'unstaged', isDirty: true })
]
const IDS = [...FIXTURE.map((file) => file.id), 'not-open']

function seed(): AppState {
  useAppStore.setState({ openFiles: FIXTURE })
  return useAppStore.getState()
}

/** Two views of one record, as the sharing switch will produce. */
const SHARED: EditorBufferViewIndex = {
  editorBufferIdOf: { a: 'rec', b: 'rec', c: 'c' },
  editorBufferViews: { rec: ['a', 'b'], c: ['c'] }
}
const SHARED_FILES = [tab('a', { isDirty: true }), tab('b', { isDirty: true }), tab('c')]

describe('editor buffer entry points return the per-tab answer', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    quiesce.mockClear()
  })

  it.each(IDS)('needsSavePromptOnClose(%s) equals the tab dirty flag', (id) => {
    const state = seed()
    const old = state.openFiles.find((file) => file.id === id)?.isDirty === true
    expect(needsSavePromptOnClose(state, id)).toBe(old)
  })

  it('restartSaveTargets equals the dirty tabs', () => {
    const state = seed()
    expect(restartSaveTargets(state)).toEqual(state.openFiles.filter((file) => file.isDirty))
  })

  it.each(IDS)('save keys for %s equal the model URI queue and the tab-id timer', (id) => {
    const state = seed()
    const file = state.openFiles.find((candidate) => candidate.id === id)
    const oldQueueKey = file?.mode === 'edit' ? editorTabModelUri(state, file) : id
    expect(EDITOR_SAVE_KEYS.queue(state, id)).toBe(oldQueueKey)
    expect(EDITOR_SAVE_KEYS.schedule(state, id)).toBe(id)
  })

  it.each([
    [false, ['rich-new', 'csv']],
    [true, ['rich-new']]
  ])('record flush keeps the per-tab semantics (autosave=%s)', (autosave, expected) => {
    const state = seed()
    const calls: string[] = []
    const remove = [
      registerPendingEditorFlush('/repo/a.ts', () => calls.push('rich-old')),
      registerPendingEditorFlush('/repo/a.ts', () => calls.push('rich-new')),
      registerPendingEditorFlush(
        '/repo/a.ts',
        () => calls.push('csv'),
        () => true
      ),
      registerPendingEditorFlush('editor:wt-2:local:/repo/a.ts', () => calls.push('other-tab'))
    ]
    try {
      flushPendingEditorBuffer(state, '/repo/a.ts', autosave)
      expect(calls).toEqual(expected)
      expect(hasPendingEditorBufferChange(state, '/repo/a.ts')).toBe(true)
      expect(hasPendingEditorBufferChange(state, 'editor:wt-2:local:/repo/a.ts')).toBe(false)
    } finally {
      remove.forEach((unregister) => unregister())
    }
  })

  it('Discard quiesces, clears dirty and the draft, then closes, as before', async () => {
    seed()
    useAppStore.getState().setEditorDraft('/repo/a.ts', 'edited')

    await discardEditorFileChangesAndClose('/repo/a.ts')

    expect(quiesce).toHaveBeenCalledWith({ fileId: '/repo/a.ts' })
    const state = useAppStore.getState()
    expect(state.openFiles.some((file) => file.id === '/repo/a.ts')).toBe(false)
    expect(state.editorDrafts['/repo/a.ts']).toBeUndefined()
    // The same path in another workspace keeps its own dirty flag.
    expect(state.editorBuffers['editor:wt-2:local:/repo/a.ts']?.isDirty).toBe(true)
  })
})

describe('entry point bodies once views share a record', () => {
  const state = { openFiles: SHARED_FILES, ...SHARED }

  it('prompts only on the last open view, whatever order a batch closes them in', () => {
    for (const [first, last] of [
      ['a', 'b'],
      ['b', 'a']
    ]) {
      expect(needsSavePromptOnClose(state, first)).toBe(false)
      const afterFirstClosed = {
        openFiles: SHARED_FILES.filter((file) => file.id !== first),
        editorBufferIdOf: { [last]: 'rec', c: 'c' },
        editorBufferViews: { rec: [last], c: ['c'] }
      }
      expect(needsSavePromptOnClose(afterFirstClosed, last)).toBe(true)
    }
  })

  it('restart save writes one view per record', () => {
    expect(restartSaveTargets(state).map((file) => file.id)).toEqual(['a'])
  })

  it('flushes pending text from every view of the record', () => {
    const calls: string[] = []
    const remove = [
      registerPendingEditorFlush('a', () => calls.push('a')),
      registerPendingEditorFlush(
        'b',
        () => calls.push('b'),
        () => true
      ),
      registerPendingEditorFlush('c', () => calls.push('c'))
    ]
    try {
      expect(hasPendingEditorBufferChange(state, 'a')).toBe(true)
      flushPendingEditorBuffer(state, 'a')
      expect(calls).toEqual(['a', 'b'])
    } finally {
      remove.forEach((unregister) => unregister())
    }
  })
})
