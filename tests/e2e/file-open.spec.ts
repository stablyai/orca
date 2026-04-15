/**
 * E2E tests for opening files and markdown preview from the right sidebar.
 *
 * User Prompt:
 * - you can open files (from the right sidebar)
 * - you can open .md files and they show up as preview (from the right sidebar)
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible,
} from './helpers/store'
import { clickFileInExplorer, openFileExplorer } from './helpers/file-explorer'
import { pressShortcut } from './helpers/shortcuts'

test.describe('File Open & Markdown Preview', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    // Clean up: close all open editor files
    const worktreeId = await getActiveWorktreeId(orcaPage)
    if (!worktreeId) {
      return
    }

    const openFiles = await getOpenFiles(orcaPage, worktreeId)
    for (const file of openFiles) {
      await orcaPage.evaluate((fileId) => {
        const store = window.__store
        if (!store) {
          return
        }

        store.getState().closeFile(fileId)
      }, file.id)
    }
    // Switch back to terminal view
    await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        return
      }

      store.getState().setActiveTabType('terminal')
    })
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('opening the right sidebar with Cmd/Ctrl+Shift+E shows file explorer', async ({ orcaPage }) => {
    await pressShortcut(orcaPage, 'e', { shift: true })

    // Verify the right sidebar is open and on the explorer tab
    await expect
      .poll(
        async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarOpen),
        { timeout: 3_000 }
      )
      .toBe(true)

    await expect
      .poll(
        async () => orcaPage.evaluate(() => window.__store?.getState().rightSidebarTab),
        { timeout: 3_000 }
      )
      .toBe('explorer')
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   */
  test('clicking a file in the file explorer opens it in an editor tab', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    const filesBefore = await getOpenFiles(orcaPage, worktreeId)

    // Click a known non-directory file
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
      'README.md',
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for the file to be opened in the editor
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // There should be a new open file
    await expect
      .poll(async () => (await getOpenFiles(orcaPage, worktreeId)).length, { timeout: 5_000 })
      .toBeGreaterThan(filesBefore.length)
  })

  /**
   * User Prompt:
   * - you can open .md files and they show up as preview (from the right sidebar)
   */
  test('opening a .md file shows markdown content', async ({ orcaPage }) => {
    await openFileExplorer(orcaPage)
    const clickedFile = await clickFileInExplorer(orcaPage, ['README.md', 'CLAUDE.md'])
    expect(clickedFile).not.toBeNull()

    // Wait for the editor tab to become active
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // Why: .md files render via EditorContent which detects isMarkdown and
    // uses either RichMarkdownEditor (ProseMirror/Tiptap) for rich editing,
    // or MarkdownPreview (react-markdown) when the content has unsupported
    // elements. Both render formatted markdown — not raw source. Monaco is
    // only used in "source" mode which is not the default for .md files.
    // We verify a rich/preview surface appeared, not just a source editor.
    // Why: the file content is loaded asynchronously after an explorer click.
    // The editor component must fetch the content, determine the render mode, then
    // mount the appropriate surface (Tiptap or preview). Give it extra time.
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            // Tiptap rich editor renders a ProseMirror element inside
            // .rich-markdown-editor-shell
            const proseMirror = document.querySelector('.ProseMirror')
            const richShell = document.querySelector('.rich-markdown-editor-shell')
            // MarkdownPreview renders into a .markdown-preview container
            const markdownPreview = document.querySelector('.markdown-preview')
            return !!(proseMirror || richShell || markdownPreview)
          }),
        { timeout: 15_000, message: 'No markdown preview or rich editor surface rendered' }
      )
      .toBe(true)
  })

  /**
   * User Prompt:
   * - you can open files (from the right sidebar)
   * - files retain state when switching tabs
   */
  test('editor tab retains state when switching to terminal and back', async ({ orcaPage }) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!
    await openFileExplorer(orcaPage)

    // Click a file to open it
    const clickedFile = await clickFileInExplorer(orcaPage, [
      'package.json',
      'tsconfig.json',
      '.gitignore',
    ])
    expect(clickedFile).not.toBeNull()

    // Wait for editor to become active
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 5_000 })
      .toBe('editor')

    // Record what files are open
    const openFilesBefore = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesBefore.length).toBeGreaterThan(0)

    // Switch to a terminal tab by navigating with keyboard
    await pressShortcut(orcaPage, 'BracketLeft', { shift: true })
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 })
      .not.toBe('editor')

    // Switch back toward the editor tab
    await pressShortcut(orcaPage, 'BracketRight', { shift: true })
    await expect
      .poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 })
      .toBe('editor')

    // The same files should still be open
    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    expect(openFilesAfter.length).toBe(openFilesBefore.length)
    expect(openFilesAfter[0].filePath).toBe(openFilesBefore[0].filePath)
  })
})
