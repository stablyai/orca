import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { registerPendingEditorFlush } from '@/components/editor/save/flush/editor-pending-flush'
import { editorTabRetirement } from './editor-tab-retirement'

it('keeps a draft typed after the last clean editor view began closing', () => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  try {
    useAppStore.setState({ activeWorktreeId: 'worktree' })
    useAppStore.setState({
      openFiles: [
        {
          id: 'draft.md',
          filePath: '/repo/draft.md',
          relativePath: 'draft.md',
          worktreeId: 'worktree',
          mode: 'edit',
          language: 'markdown',
          isDirty: false
        }
      ]
    })
    const tab = useAppStore.getState().createUnifiedTab('worktree', 'editor', {
      entityId: 'draft.md',
      label: 'draft.md'
    })
    const retire = editorTabRetirement(
      useAppStore.setState,
      useAppStore.getState,
      useAppStore.getState(),
      tab
    )
    useAppStore.getState().markFileDirty('draft.md', true)
    const unregister = registerPendingEditorFlush('draft.md', () =>
      useAppStore.getState().setEditorDraft('draft.md', '# Text typed while closing')
    )
    try {
      // An accepted layout frame removes the tab before the retirement callback runs.
      useAppStore.setState({ unifiedTabsByWorktree: { worktree: [] } })
      retire()
      expect(useAppStore.getState().editorDrafts['draft.md']).toBe('# Text typed while closing')
      expect(useAppStore.getState().openFiles[0]?.isDirty).toBe(true)
    } finally {
      unregister()
    }
  } finally {
    useAppStore.setState(useAppStore.getInitialState(), true)
  }
})
