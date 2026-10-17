import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { getActiveWorktreeContext } from './helpers/markdown-editor-fixture'

declare global {
  var __failedDiffReads: boolean | undefined
  var __failedDiffWriteContents: string[] | undefined
}

test('a failed diff cannot replace file bytes, and recovery remains editable', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const context = await getActiveWorktreeContext(orcaPage)
  await orcaPage.setViewportSize({ width: 1000, height: 850 })
  const filePath = path.join(context.rootPath, 'README.md')
  const original = await readFile(filePath, 'utf8')
  const protectedContent = 'PROTECTED_FILE_CONTENT\n'
  await writeFile(filePath, protectedContent)
  registerPostElectronShutdownCleanup(() => writeFile(filePath, original))
  await orcaPage.evaluate(() =>
    window.__store
      ?.getState()
      .updateSettings({ editorAutoSave: false, diffDefaultView: 'side-by-side' })
  )
  await electronApp.evaluate(
    ({ ipcMain }, { rootPath, filePath }) => {
      if (!('_invokeHandlers' in ipcMain) || !(ipcMain._invokeHandlers instanceof Map)) {
        throw new Error('File handlers unavailable')
      }
      const diff = ipcMain._invokeHandlers.get('git:diff')
      const write = ipcMain._invokeHandlers.get('fs:writeFile')
      if (typeof diff !== 'function' || typeof write !== 'function') {
        throw new Error('Diff or write handler unavailable')
      }
      globalThis.__failedDiffReads = true
      globalThis.__failedDiffWriteContents = []
      ipcMain.removeHandler('git:diff')
      ipcMain.handle('git:diff', (event, args) => {
        if (
          globalThis.__failedDiffReads &&
          args?.worktreePath === rootPath &&
          args.filePath === 'README.md'
        ) {
          throw new Error('controlled diff load failure')
        }
        return diff(event, args)
      })
      ipcMain.removeHandler('fs:writeFile')
      ipcMain.handle('fs:writeFile', (event, args) => {
        if (args?.filePath === filePath) {
          globalThis.__failedDiffWriteContents?.push(args.content)
        }
        return write(event, args)
      })
    },
    { rootPath: context.rootPath, filePath }
  )

  await orcaPage.evaluate(
    ({ filePath, worktreeId }) => {
      window.__store?.getState().openFile({
        filePath,
        relativePath: 'README.md',
        worktreeId,
        language: 'markdown',
        mode: 'diff',
        diffSource: 'unstaged'
      })
    },
    { filePath, worktreeId: context.worktreeId }
  )
  const pane = orcaPage.locator('.modified-in-monaco-diff-editor')
  const textLines = pane.locator('.view-lines[role="presentation"]')
  await expect(pane).toBeVisible({ timeout: 25_000 })
  await expect(textLines).toContainText('controlled diff load failure')
  await pane.click()
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await orcaPage.screenshot({
    path: testInfo.outputPath('failed-diff-after-save.png'),
    animations: 'disabled'
  })
  const attemptedWrites = await electronApp.evaluate(() => globalThis.__failedDiffWriteContents)
  await testInfo.attach('failed-diff-write-attempts', {
    body: Buffer.from(JSON.stringify(attemptedWrites)),
    contentType: 'application/json'
  })
  expect(await readFile(filePath, 'utf8')).toBe(protectedContent)
  expect(attemptedWrites).toEqual([])
  await orcaPage.keyboard.type('X')
  expect(
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return state?.activeFileId ? state.editorDrafts[state.activeFileId] : null
    })
  ).toBeUndefined()

  await electronApp.evaluate(() => {
    globalThis.__failedDiffReads = false
  })
  await orcaPage.evaluate(({ worktreeId, rootPath }) => {
    window.dispatchEvent(
      new CustomEvent('orca:editor-external-file-change', {
        detail: { worktreeId, worktreePath: rootPath, relativePath: 'README.md' }
      })
    )
  }, context)
  await expect(textLines).toContainText('PROTECTED_FILE_CONTENT')
  await pane.click()
  await orcaPage.keyboard.press('ControlOrMeta+End')
  await orcaPage.keyboard.type(' RECOVERED_EDIT')
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect.poll(() => readFile(filePath, 'utf8')).toContain('RECOVERED_EDIT')
  await orcaPage.screenshot({
    path: testInfo.outputPath('recovered-diff-saved.png'),
    animations: 'disabled'
  })
})
