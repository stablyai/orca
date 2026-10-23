// @vitest-environment happy-dom
// Why: a read-only tab renders raw Monaco source on the shared model whatever its file type, so it
// must show a writable view's unsaved edits (one record), never push disk text over them.
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { toEditorModelUri } from './editor-model-uri'
import { mayPushTabTextIntoModel } from './editor-stale-mount-guard'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'

function tab(id: string, filePath: string, patch: Partial<OpenFile> = {}): OpenFile {
  return {
    id,
    filePath,
    relativePath: filePath.slice('/repo/'.length),
    worktreeId: 'wt-1',
    language: filePath.endsWith('.csv') ? 'csv' : 'markdown',
    isDirty: false,
    mode: 'edit',
    lastKnownDiskSignature: 'sig',
    ...patch
  }
}

afterEach(() => {
  for (const model of monaco.editor.getModels()) {
    model.dispose()
  }
})

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  // A resolved local owner, so both tabs map to one model URI.
  useAppStore.setState({
    worktreesByRepo: {
      'repo-1': [makeWorktree({ id: 'wt-1', repoId: 'repo-1', path: '/repo', hostId: 'local' })]
    }
  })
})

it.each(['/repo/notes.md', '/repo/data.csv', '/repo/log.jsonl'])(
  'a read-only %s view joins a dirty writable view and shows its edits, not disk text',
  (filePath) => {
    useAppStore.setState({
      openFiles: [tab('writable', filePath, { isDirty: true })],
      editorDrafts: { writable: 'unsaved edits' },
      markdownViewMode: { writable: 'source' }
    })
    useAppStore.setState((s) => ({
      openFiles: [...s.openFiles, tab('read-only', filePath, { readOnly: true })]
    }))

    // Views of one file share a record: the read-only view joins it and shows the unsaved edits.
    const state = useAppStore.getState()
    expect(state.openFiles.find((file) => file.id === 'read-only')?.isDirty).toBe(true)
    expect(state.editorDrafts['read-only']).toBe('unsaved edits')
    expect(state.editorBufferIdOf['read-only']).toBe(state.editorBufferIdOf.writable)

    // The shared model holds the unsaved edits; whatever the read-only view pushes keeps them.
    const model = monaco.editor.createModel(
      'unsaved edits',
      'plaintext',
      monaco.Uri.parse(toEditorModelUri(filePath))
    )
    const diskText = 'disk text'
    const pushed = mayPushTabTextIntoModel('read-only') ? state.editorDrafts['read-only'] : diskText
    if (pushed !== undefined) {
      model.setValue(pushed)
    }
    expect(model.getValue()).toBe('unsaved edits')
  }
)

it('a read-only view may still load disk text into a clean model', () => {
  useAppStore.setState({
    openFiles: [
      tab('writable', '/repo/notes.md'),
      tab('read-only', '/repo/notes.md', { readOnly: true })
    ],
    markdownViewMode: { writable: 'source' }
  })
  expect(mayPushTabTextIntoModel('read-only')).toBe(true)
})

it('a dirty view with no draft never pushes its text over the shared model', () => {
  useAppStore.setState({
    openFiles: [tab('mirrored', '/repo/notes.md', { isDirty: true })],
    editorDrafts: {}
  })
  expect(mayPushTabTextIntoModel('mirrored')).toBe(false)
})

it('a dirty view with a draft may push it', () => {
  useAppStore.setState({
    openFiles: [tab('writable', '/repo/notes.md', { isDirty: true })],
    editorDrafts: { writable: 'edits' }
  })
  expect(mayPushTabTextIntoModel('writable')).toBe(true)
})
