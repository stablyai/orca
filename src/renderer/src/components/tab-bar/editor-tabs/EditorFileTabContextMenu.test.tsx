// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useAppStore } from '@/store/index'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { EditorFileTabContextMenu } from './EditorFileTabContextMenu'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('opens the Files tree at the file from the context menu, even when another tab is active', () => {
  const worktree = makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id, path: 'C:/project' })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] },
    activeWorktreeId: 'wt-1',
    activeFileId: 'other-tab',
    rightSidebarOpen: false,
    rightSidebarTab: 'source-control',
    rightSidebarExplorerView: 'search'
  })
  const noop = (): void => {}
  render(
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button type="button">notes.md</button>
      </ContextMenuTrigger>
      <EditorFileTabContextMenu
        file={{
          id: 'notes-tab',
          filePath: 'C:/project/docs/notes.md',
          relativePath: 'docs/notes.md',
          worktreeId: 'wt-1',
          language: 'markdown',
          mode: 'edit',
          isDirty: true
        }}
        unifiedTabId="notes-tab"
        groupId="group-1"
        isPinned={false}
        isRenaming={false}
        hasTabsToRight={false}
        hasTabsToLeft
        tabCount={2}
        canRename
        canShowMarkdownPreview={false}
        resolvedLanguage="markdown"
        repoConnectionId={null}
        skipMenuFocusRestoreRef={{ current: false }}
        onActivate={noop}
        onOpenRenameInput={noop}
        onTogglePin={noop}
        onClose={noop}
        onCloseOthers={noop}
        onCloseAll={noop}
        onCloseToRight={noop}
        onCloseToLeft={noop}
        onOpenMarkdownPreview={noop}
      />
    </ContextMenu>
  )

  fireEvent.contextMenu(screen.getByRole('button', { name: 'notes.md' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in Orca Explorer' }))

  expect(useAppStore.getState()).toMatchObject({
    rightSidebarOpen: true,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    pendingExplorerReveal: { worktreeId: 'wt-1', filePath: 'C:/project/docs/notes.md' }
  })
})
