import { readFile, rm } from 'node:fs/promises'
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

test('a deleted dirty file stays missing until Restore File is chosen', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    'save-integrity-fixtures',
    'deleted-draft',
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
    instance.editor.commands.insertContentAt(
      instance.editor.state.doc.content.size - 1,
      ' RETAINED_DRAFT'
    )
  })
  await expect(editor.locator('p').first()).toHaveText('Saved on disk. RETAINED_DRAFT')
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((file) => file.filePath === filePath)
        return file ? state?.editorDrafts[file.id] : null
      }, filePath)
    )
    .toContain('RETAINED_DRAFT')
  await rm(filePath)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (filePath) =>
          window.__store?.getState().openFiles.find((file) => file.filePath === filePath)
            ?.externalMutation,
        filePath
      )
    )
    .toBe('deleted')
  await orcaPage.evaluate(() =>
    window.__store?.getState().updateSettings({ editorAutoSave: true, editorAutoSaveDelayMs: 1000 })
  )
  await orcaPage.waitForTimeout(2500)
  await orcaPage.screenshot({
    path: testInfo.outputPath('after-delete-autosave-window.png'),
    animations: 'disabled'
  })
  const diskContent = await readFile(filePath, 'utf8').catch(() => null)
  await testInfo.attach('disk-after-autosave-window', {
    body: JSON.stringify({ diskContent }),
    contentType: 'application/json'
  })
  expect(diskContent).toBeNull()
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => {
        const state = window.__store?.getState()
        const file = state?.openFiles.find((file) => file.filePath === filePath)
        return file
          ? {
              dirty: file.isDirty,
              mutation: file.externalMutation,
              draft: state?.editorDrafts[file.id]
            }
          : null
      }, filePath)
    )
    .toEqual({ dirty: true, mutation: 'deleted', draft: expect.stringContaining('RETAINED_DRAFT') })
  await orcaPage.getByRole('button', { name: 'Restore File', exact: true }).click()
  await expect.poll(() => readFile(filePath, 'utf8').catch(() => null)).toContain('RETAINED_DRAFT')
  await expect
    .poll(() =>
      orcaPage.evaluate((filePath) => {
        const file = window.__store?.getState().openFiles.find((file) => file.filePath === filePath)
        return file ? { dirty: file.isDirty, mutation: file.externalMutation } : null
      }, filePath)
    )
    .toEqual({ dirty: false, mutation: undefined })
  await expect(orcaPage.getByRole('button', { name: 'Restore File', exact: true })).toHaveCount(0)
  await expect(editor.locator('p').first()).toHaveText('Saved on disk. RETAINED_DRAFT')
  await orcaPage.screenshot({
    path: testInfo.outputPath('explicitly-restored-file.png'),
    animations: 'disabled'
  })
})
