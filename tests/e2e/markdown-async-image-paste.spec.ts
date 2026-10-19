import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Editor } from '@tiptap/core'
import type { Locator } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  cleanupMarkdownFixture,
  createMarkdownFixture,
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAYUlEQVR4nO3PIREAIBAAMFqhMWgyUYMun4QQaBQZEO92twIrZ/RUde1URUBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgO9BiprrRUgkICAgICAgICAgICAgICAgICAgICAgIfHuebLmH1pKnMwAAAABJRU5ErkJggg=='

type RichMarkdownImageEditorElement = HTMLElement & { editor?: Editor }

declare global {
  var __markdownImagePasteRelease: (() => void) | undefined
}

async function pasteImage(editor: Locator) {
  return editor.evaluate((element, png) => {
    const editorElement =
      document.querySelector<RichMarkdownImageEditorElement>('.rich-markdown-editor')
    if (!editorElement || editorElement !== element || !editorElement.editor) {
      throw new Error('Markdown editor unavailable')
    }
    const instance = editorElement.editor
    const readSelection = () => ({
      from: instance.state.selection.from,
      to: instance.state.selection.to,
      selectedText: instance.state.doc.textBetween(
        instance.state.selection.from,
        instance.state.selection.to
      )
    })
    const priorSelection = readSelection()
    // Establish the selection in the paste turn, after initial focus and screenshot work.
    editorElement.focus()
    instance.commands.setTextSelection({ from: 7, to: 12 })
    const data = new DataTransfer()
    const bytes = Uint8Array.from(atob(png), (character) => character.charCodeAt(0))
    data.items.add(new File([bytes], 'image.png', { type: 'image/png' }))
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: data
    })
    const before = readSelection()
    const domSelection = window.getSelection()?.toString()
    element.dispatchEvent(event)
    return {
      priorSelection,
      before,
      after: readSelection(),
      domSelection,
      handled: event.defaultPrevented
    }
  }, PNG)
}

test('image paste replaces its selection after editing during clipboard import', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-image',
    'async-image',
    testInfo.workerIndex,
    'hello world\n\nThe selected word should be replaced by this image.'
  )
  const imagePath = testInfo.outputPath('deferred-image.png')
  await writeFile(imagePath, Buffer.from(PNG, 'base64'))
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  registerPostElectronShutdownCleanup(() =>
    cleanupMarkdownFixture(path.join(path.dirname(filePath), path.basename(imagePath)))
  )
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor.locator('p').first()).toHaveText('hello world')
  await orcaPage.screenshot({ path: testInfo.outputPath('image-document-before-paste.png') })

  // Substitute clipboard persistence without reading or writing the system clipboard.
  await electronApp.evaluate(({ ipcMain }, imagePath) => {
    ipcMain.removeHandler('clipboard:saveImageAsTempFile')
    ipcMain.handle(
      'clipboard:saveImageAsTempFile',
      () =>
        new Promise<string>((resolve) => {
          globalThis.__markdownImagePasteRelease = () => resolve(imagePath)
        })
    )
  }, imagePath)
  const pasteSelection = await pasteImage(editor)
  await testInfo.attach('selection-at-image-paste', {
    body: Buffer.from(JSON.stringify(pasteSelection, null, 2)),
    contentType: 'application/json'
  })
  expect(pasteSelection.before).toEqual({ from: 7, to: 12, selectedText: 'world' })
  expect(pasteSelection.after).toEqual(pasteSelection.before)
  expect(pasteSelection.handled).toBe(true)
  await expect
    .poll(() =>
      electronApp.evaluate(() => typeof globalThis.__markdownImagePasteRelease === 'function')
    )
    .toBe(true)

  await editor.evaluate((element) => {
    const editorElement =
      document.querySelector<RichMarkdownImageEditorElement>('.rich-markdown-editor')
    if (!editorElement || editorElement !== element || !editorElement.editor) {
      throw new Error('Markdown editor unavailable')
    }
    editorElement.editor.commands.setTextSelection(1)
  })
  await orcaPage.keyboard.type('prefix ')
  await expect(editor.locator('p').first()).toHaveText('prefix hello world')
  await electronApp.evaluate(() => {
    const release = globalThis.__markdownImagePasteRelease
    if (typeof release !== 'function') {
      throw new Error('Clipboard import not pending')
    }
    release()
    globalThis.__markdownImagePasteRelease = undefined
  })
  const image = editor.locator('img:not(.ProseMirror-separator)')
  await expect(image).toHaveCount(1)
  await expect(image).toBeVisible()
  await expect
    .poll(() =>
      image.evaluate(
        (image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
      )
    )
    .toBe(true)
  await orcaPage.keyboard.type('continued ')
  await orcaPage.screenshot({ path: testInfo.outputPath('image-after-delayed-paste.png') })
  await testInfo.attach('image-after-delayed-paste', {
    path: testInfo.outputPath('image-after-delayed-paste.png'),
    contentType: 'image/png'
  })
  await expect(editor.locator('p').first()).toHaveText('prefix continued hello ')
  expect(
    await editor.evaluate(() => {
      const instance =
        document.querySelector<RichMarkdownImageEditorElement>('.rich-markdown-editor')?.editor
      if (!instance) {
        throw new Error('Markdown editor unavailable')
      }
      const content: (string | undefined)[] = []
      instance.state.doc.firstChild?.forEach((node) => {
        content.push(node.isText ? node.text : node.type.name)
      })
      return content
    })
  ).toEqual(['prefix continued hello ', 'image'])
  await expect(editor.locator('p').nth(1)).toHaveText(
    'The selected word should be replaced by this image.'
  )
})

test('image paste reports cancellation when the selected target changes before import', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  const filePath = await createMarkdownFixture(
    context,
    '.orca-e2e-markdown-image',
    'cancel-image',
    testInfo.workerIndex,
    'hello world'
  )
  const imagePath = testInfo.outputPath('pending-image.png')
  await writeFile(imagePath, Buffer.from(PNG, 'base64'))
  registerPostElectronShutdownCleanup(() => cleanupMarkdownFixture(filePath))
  await openMarkdownFixture(orcaPage, context, filePath)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await electronApp.evaluate(({ ipcMain }, imagePath) => {
    ipcMain.removeHandler('clipboard:saveImageAsTempFile')
    ipcMain.handle(
      'clipboard:saveImageAsTempFile',
      () =>
        new Promise<string>((resolve) => {
          globalThis.__markdownImagePasteRelease = () => resolve(imagePath)
        })
    )
  }, imagePath)
  const pasteSelection = await pasteImage(editor)
  expect(pasteSelection.before).toEqual({ from: 7, to: 12, selectedText: 'world' })
  expect(pasteSelection.after).toEqual(pasteSelection.before)
  expect(pasteSelection.handled).toBe(true)
  await expect
    .poll(() =>
      electronApp.evaluate(() => typeof globalThis.__markdownImagePasteRelease === 'function')
    )
    .toBe(true)

  await editor.evaluate((element) => {
    const editorElement =
      document.querySelector<RichMarkdownImageEditorElement>('.rich-markdown-editor')
    if (!editorElement || editorElement !== element || !editorElement.editor) {
      throw new Error('Markdown editor unavailable')
    }
    editorElement.focus()
    editorElement.editor.commands.setTextSelection({ from: 7, to: 12 })
    editorElement.editor.commands.insertContent('changed')
  })
  await electronApp.evaluate(() => {
    const release = globalThis.__markdownImagePasteRelease
    if (typeof release !== 'function') {
      throw new Error('Clipboard import not pending')
    }
    release()
    globalThis.__markdownImagePasteRelease = undefined
  })
  await expect(editor.locator('p').first()).toHaveText('hello changed')
  await expect(editor.locator('img:not(.ProseMirror-separator)')).toHaveCount(0)
  const cancellationMessage = orcaPage.getByText(
    'Image insertion canceled because the destination changed. Try again.',
    { exact: true }
  )
  await expect(cancellationMessage).toBeVisible()
  const screenshot = testInfo.outputPath('image-cancellation-feedback.png')
  await orcaPage.screenshot({ path: screenshot, animations: 'disabled' })
  await testInfo.attach('image-cancellation-feedback', {
    path: screenshot,
    contentType: 'image/png'
  })
})
