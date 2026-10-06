import { readFile, rm, writeFile } from 'node:fs/promises'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeActiveEditorTab, waitForRichMarkdownEditor } from './helpers/markdown-editor-fixture'

declare global {
  var __untitledNoteStatRelease: (() => void) | undefined
  var __untitledNoteStatArmed: boolean | undefined
}

async function createNote(page: Page): Promise<{ id: string; filePath: string }> {
  const previousIds = await page.evaluate(
    () => window.__store?.getState().openFiles.map((file) => file.id) ?? []
  )
  await page.getByRole('button', { name: 'New tab' }).click({ force: true })
  await page
    .getByRole('menuitem', { name: /New Markdown/i })
    .first()
    .click()
  await page.waitForFunction((previousIds) => {
    const state = window.__store?.getState()
    return state?.openFiles.some(
      (file) => file.id === state.activeFileId && !previousIds.includes(file.id)
    )
  }, previousIds)
  const note = await page.evaluate(() => {
    const state = window.__store?.getState()
    const file = state?.openFiles.find((file) => file.id === state.activeFileId)
    return file ? { id: file.id, filePath: file.filePath } : null
  })
  if (!note) {
    throw new Error('Created note is unavailable')
  }
  await waitForRichMarkdownEditor(page)
  return note
}

async function reopenNote(page: Page, noteId: string): Promise<void> {
  await page.evaluate(() => document.body.focus())
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+Shift+t`)
  await expect.poll(() => page.evaluate(() => window.__store?.getState().activeFileId)).toBe(noteId)
}

test('an empty Markdown note survives close and reopens through the shortcut', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const note = await createNote(orcaPage)
  registerPostElectronShutdownCleanup(() => rm(note.filePath, { force: true }))
  await expect.poll(() => readFile(note.filePath, 'utf8')).toBe('')
  await closeActiveEditorTab(orcaPage, note.filePath)
  await reopenNote(orcaPage, note.id)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor).toHaveText('')
  expect(await readFile(note.filePath, 'utf8')).toBe('')
  await orcaPage.screenshot({ path: testInfo.outputPath('empty-note-reopened.png') })
  await testInfo.attach('Empty note reopened', {
    path: testInfo.outputPath('empty-note-reopened.png'),
    contentType: 'image/png'
  })
})

test('closing a note cannot delete content written after an old empty stat', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const note = await createNote(orcaPage)
  registerPostElectronShutdownCleanup(() => rm(note.filePath, { force: true }))
  await electronApp.evaluate(({ ipcMain }, filePath) => {
    globalThis.__untitledNoteStatArmed = true
    ipcMain.removeHandler('fs:stat')
    ipcMain.handle('fs:stat', async (_event, request: { filePath: string }) => {
      const fs = process.getBuiltinModule('node:fs/promises')
      const stat = await fs.stat(request.filePath)
      const snapshot = { size: stat.size, isDirectory: stat.isDirectory(), mtime: stat.mtimeMs }
      if (request.filePath === filePath && globalThis.__untitledNoteStatArmed) {
        await new Promise<void>((resolve) => {
          globalThis.__untitledNoteStatRelease = resolve
        })
      }
      return snapshot
    })
  }, note.filePath)
  await closeActiveEditorTab(orcaPage, note.filePath)
  const content = 'A background writer finished this note after the tab closed.'
  await writeFile(note.filePath, content, 'utf8')
  const probedEmptyFile = await electronApp.evaluate(() => {
    globalThis.__untitledNoteStatArmed = false
    const requested = Boolean(globalThis.__untitledNoteStatRelease)
    globalThis.__untitledNoteStatRelease?.()
    return requested
  })
  await testInfo.attach('Empty-file stat requested on close', {
    body: JSON.stringify({ requested: probedEmptyFile }),
    contentType: 'application/json'
  })
  let stableSince = 0
  try {
    await expect
      .poll(
        async () => {
          const saved = await readFile(note.filePath, 'utf8').catch(() => null)
          if (saved !== content) {
            stableSince = 0
            return false
          }
          stableSince ||= performance.now()
          return performance.now() - stableSince >= 500
        },
        { intervals: [100] }
      )
      .toBe(true)
  } finally {
    const disk = await readFile(note.filePath, 'utf8')
      .then((saved) => ({ content: saved }))
      .catch((error) => ({ error: error instanceof Error ? error.message : String(error) }))
    await testInfo.attach('Note disk contents after close', {
      body: JSON.stringify(disk),
      contentType: 'application/json'
    })
  }
  await reopenNote(orcaPage, note.id)
  const editor = await waitForRichMarkdownEditor(orcaPage)
  await expect(editor).toHaveText(content)
  expect(await readFile(note.filePath, 'utf8')).toBe(content)
  await orcaPage.screenshot({ path: testInfo.outputPath('background-note-reopened.png') })
  await testInfo.attach('Background note retained and reopened', {
    path: testInfo.outputPath('background-note-reopened.png'),
    contentType: 'image/png'
  })
})
