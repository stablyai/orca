/**
 * Closing a file that belongs to a background workspace must not change what the focused
 * workspace shows, even when that workspace has no files, browsers or terminals of its own.
 */
import { describe, expect, it, vi } from 'vitest'
import { createEditorTabsStore } from './editor-slice-test-harness'

vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

describe('closing a background workspace’s last file', () => {
  it('keeps the focused workspace selected and its surface unchanged', () => {
    const store = createEditorTabsStore()
    const fileId = store.getState().openFile({
      filePath: '/repo-b/notes.md',
      relativePath: 'notes.md',
      worktreeId: 'wt-background',
      language: 'markdown',
      mode: 'edit'
    })
    store.setState({
      activeWorktreeId: 'wt-focused',
      activeTabType: 'agent-session',
      activeTabTypeByWorktree: { 'wt-focused': 'agent-session' }
    })

    store.getState().closeFile(fileId)

    const state = store.getState()
    expect(state.openFiles).toEqual([])
    expect(state.activeWorktreeId).toBe('wt-focused')
    expect(state.activeTabType).toBe('agent-session')
    expect(state.activeTabTypeByWorktree['wt-focused']).toBe('agent-session')
  })
})
