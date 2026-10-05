import { describe, expect, it } from 'vitest'
import {
  getDefaultWorkspaceSession,
  FLOATING_TERMINAL_WORKTREE_ID
} from '../../../../shared/constants'
import { buildEditorSessionData } from '@/lib/workspace-session'
import { createTestStore } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'
import { buildDiffEditorFileId } from './editor/file-ids/editor-file-ids'

createStoreSessionMockApi()

describe('editable diff session recovery', () => {
  it('round trips separate edit and unstaged diff drafts for the same path, including empty text', () => {
    const store = createTestStore()
    const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
    const filePath = '/workspace/note.txt'
    const diffId = buildDiffEditorFileId(worktreeId, 'unstaged', 'note.txt', undefined)
    const common = { filePath, worktreeId, relativePath: 'note.txt', language: 'plaintext' }
    const editor = buildEditorSessionData(
      [
        {
          ...common,
          id: filePath,
          mode: 'edit',
          isDirty: true,
          lastKnownDiskSignature: 'baseline'
        },
        { ...common, id: diffId, mode: 'diff', diffSource: 'unstaged', isDirty: true },
        { ...common, id: 'staged', mode: 'diff', diffSource: 'staged', isDirty: false }
      ],
      { [filePath]: 'edit draft', [diffId]: '' },
      {},
      { [worktreeId]: diffId },
      { [worktreeId]: 'editor' }
    )
    expect(editor.openFilesByWorktree?.[worktreeId]).toHaveLength(2)
    store.setState({ activeWorktreeId: worktreeId })
    store.getState().hydrateEditorSession({ ...getDefaultWorkspaceSession(), ...editor })
    const state = store.getState()
    const edit = state.openFiles.find((file) => file.mode === 'edit')
    const diff = state.openFiles.find((file) => file.mode === 'diff')
    if (!edit || !diff) {
      throw new Error('Both writable surfaces must restore')
    }
    expect(edit.id).not.toBe(diff.id)
    expect(state.editorDrafts[edit.id]).toBe('edit draft')
    expect(state.editorDrafts[diff.id]).toBe('')
    expect(edit.lastKnownDiskSignature).toBe('baseline')
    expect(diff.diffSource).toBe('unstaged')
    expect(edit.pendingDiskBaselineVerification).toBe(true)
    expect(diff.pendingDiskBaselineVerification).toBe(true)
    expect(state.activeFileId).toBe(diff.id)
  })
})
