import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Editor } from '@tiptap/core'
import { test, expect } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

type MarkdownEditorElement = HTMLElement & { editor?: Editor }

declare global {
  var __saveCloseWriteRelease: (() => void) | undefined
  var __saveCloseWriteCaptured: string | undefined
}

test('Save and Close preserves text typed while its disk write is pending', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-save-close',
    'concurrent-edit',
    testInfo.workerIndex,
    'Saved on disk.\n'
  )
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorAutoSave: false })
  )
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor.locator('p').first()).toHaveText('Saved on disk.')
  await editor.evaluate((element) => {
    const instance = document.querySelector<MarkdownEditorElement>('.rich-markdown-editor')
    if (!instance || instance !== element || !instance.editor) {
      throw new Error('Markdown editor unavailable')
    }
    instance.focus()
    instance.editor.commands.setTextSelection(instance.editor.state.doc.content.size - 1)
  })
  await orcaPage.keyboard.type(' BEFORE_SAVE')
  await expect(editor.locator('p').first()).toHaveText('Saved on disk. BEFORE_SAVE')

  await electronApp.evaluate(({ ipcMain }, filePath) => {
    if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
      throw new Error('File write handlers unavailable')
    }
    const original = ipcMain._invokeHandlers.get('fs:writeFile')
    if (typeof original !== 'function') {
      throw new Error('File write handler unavailable')
    }
    const gate = Promise.withResolvers<void>()
    globalThis.__saveCloseWriteRelease = gate.resolve
    ipcMain.removeHandler('fs:writeFile')
    ipcMain.handle('fs:writeFile', async (event, args) => {
      if (args?.filePath === filePath) {
        ipcMain.removeHandler('fs:writeFile')
        ipcMain.handle('fs:writeFile', original)
        globalThis.__saveCloseWriteCaptured = args.content
        await gate.promise
      }
      return original(event, args)
    })
  }, filePath)

  const tab = orcaPage
    .locator('[data-tab-id]')
    .filter({ hasText: path.basename(filePath) })
    .last()
  await tab.hover()
  await tab.getByRole('button', { name: 'Close tab' }).click()
  await orcaPage.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__saveCloseWriteCaptured))
    .toContain('BEFORE_SAVE')
  await editor.evaluate((element) => {
    const instance = document.querySelector<MarkdownEditorElement>('.rich-markdown-editor')
    if (!instance || instance !== element || !instance.editor) {
      throw new Error('Markdown editor unavailable')
    }
    instance.focus()
    instance.editor.commands.setTextSelection(instance.editor.state.doc.content.size - 1)
  })
  await orcaPage.keyboard.type(' NEWER_DRAFT')
  await expect(editor.locator('p').first()).toHaveText('Saved on disk. BEFORE_SAVE NEWER_DRAFT')
  await orcaPage.screenshot({
    path: testInfo.outputPath('edit-during-save.png'),
    animations: 'disabled'
  })
  await electronApp.evaluate(() => {
    if (!globalThis.__saveCloseWriteRelease) {
      throw new Error('File write was not pending')
    }
    globalThis.__saveCloseWriteRelease()
  })
  await expect.poll(() => readFile(filePath, 'utf8')).toContain('BEFORE_SAVE')
  await expect.poll(() => readFile(filePath, 'utf8')).not.toContain('NEWER_DRAFT')
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((file) => file.filePath === filePath)
        return file ? { dirty: file.isDirty, draft: state?.editorDrafts[file.id] } : null
      }, filePath)
    )
    .toEqual({ dirty: true, draft: expect.stringContaining('NEWER_DRAFT') })
  await orcaPage.screenshot({
    path: testInfo.outputPath('newer-edit-preserved.png'),
    animations: 'disabled'
  })

  await expect(
    orcaPage.getByText('Save timed out or failed. Fix errors before closing.', { exact: true })
  ).toHaveCount(0)
  const saveButton = orcaPage.getByRole('dialog').getByRole('button', { name: 'Save', exact: true })
  await expect(saveButton).toBeEnabled()
  await saveButton.click()
  await expect.poll(() => readFile(filePath, 'utf8')).toContain('NEWER_DRAFT')
  await expect(editor).toHaveCount(0)
})
