import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { openMarkdownFixture, waitForRichMarkdownEditor } from './helpers/markdown-editor-fixture'
import { pressShortcut } from './helpers/shortcuts'
import { waitForSessionReady } from './helpers/store'

test('folder workspace review notes support save, send-menu and clear flows', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const folderPath = await mkdtemp(path.join(os.tmpdir(), 'orca-review-notes-folder-'))
  registerPostElectronShutdownCleanup(() => rm(folderPath, { recursive: true, force: true }))
  const filePath = path.join(folderPath, 'review.md')
  await writeFile(filePath, 'A paragraph for reviewing a folder workspace.\n')
  const context = await orcaPage.evaluate(async (folderPath) => {
    const store = window.__store!
    await store.getState().updateSettings({ uiLanguage: 'en' })
    await store
      .getState()
      .setKeybindingOverride('sourceControl.sendReviewNotes', ['Mod+Shift+Enter'])
    const repo = await store.getState().addNonGitFolder(folderPath)
    if (!repo) {
      throw new Error('Folder fixture was not added')
    }
    const worktree = store.getState().worktreesByRepo[repo.id]?.[0]
    if (!worktree) {
      throw new Error('Folder workspace was not created')
    }
    store.getState().setActiveWorktree(worktree.id)
    return { worktreeId: worktree.id, rootPath: worktree.path }
  }, folderPath)
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await editor.click()
  await pressShortcut(orcaPage, 'KeyA')
  await pressShortcut(orcaPage, 'KeyA', { shift: true })

  const composer = orcaPage.locator('.orca-diff-comment-popover')
  const draft = composer.locator('textarea')
  await expect(draft).toBeVisible()
  await draft.fill('Keep this folder review note.')
  await pressShortcut(orcaPage, 'KeyA', { shift: true })
  await expect(draft).toHaveValue('Keep this folder review note.')
  await orcaPage.keyboard.press('Enter')
  await expect(composer).toHaveCount(0)

  await editor.click()
  await pressShortcut(orcaPage, 'Enter', { shift: true })
  const sendMenu = orcaPage.getByRole('menu')
  await expect(sendMenu.getByText('New agent', { exact: true })).toBeVisible()
  const screenshot = testInfo.outputPath('folder-review-notes.png')
  await orcaPage.screenshot({ path: screenshot })
  await testInfo.attach('folder review notes', { path: screenshot, contentType: 'image/png' })
  await orcaPage.keyboard.press('Escape')
  await expect(sendMenu).toHaveCount(0)

  const collapsedNotes = orcaPage.getByRole('button', { name: /Expand notes/ })
  if (await collapsedNotes.count()) {
    await collapsedNotes.click()
  }
  await expect(
    orcaPage.getByText('Keep this folder review note.', { exact: true }).first()
  ).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Copy all notes to clipboard' })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'More note actions' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Clear all notes...' }).click()
  const clearDialog = orcaPage.getByRole('dialog', { name: 'Clear Notes' })
  await expect(clearDialog).toBeVisible()
  await clearDialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(orcaPage.getByRole('button', { name: 'Copy all notes to clipboard' })).toBeVisible()

  await orcaPage.getByRole('button', { name: 'More note actions' }).click()
  await orcaPage.getByRole('menuitem', { name: 'Clear all notes...' }).click()
  await clearDialog.getByRole('button', { name: 'Clear Notes', exact: true }).click()
  await expect(clearDialog).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'More note actions' })).toHaveCount(0)
  await expect(orcaPage.getByText('Keep this folder review note.', { exact: true })).toHaveCount(0)

  await editor.click()
  await pressShortcut(orcaPage, 'Enter', { shift: true })
  await expect(orcaPage.getByRole('menu')).toHaveCount(0)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
