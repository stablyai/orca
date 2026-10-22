// Why: a read-only tab renders raw Monaco source on the shared model whatever its file type, so a
// clean read-only .md/.csv tab must never push disk text over a writable tab's unsaved edits.
import { beforeEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
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
  'a read-only %s view never pushes disk text over a dirty writable source view',
  (filePath) => {
    useAppStore.setState({
      openFiles: [
        tab('writable', filePath, { isDirty: true }),
        tab('read-only', filePath, { readOnly: true })
      ],
      editorDrafts: { writable: 'unsaved edits' },
      markdownViewMode: { writable: 'source' }
    })

    expect(mayPushTabTextIntoModel('read-only')).toBe(false)
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
