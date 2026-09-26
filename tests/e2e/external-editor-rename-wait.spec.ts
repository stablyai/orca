import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { activateGoldenWorktree } from './helpers/golden-source-control'
import {
  captureExternalEditorEvidence,
  startExternalEditorCli
} from './helpers/external-editor-cli'

for (const restoreOriginal of [false, true]) {
  test(`external editor follows a parent rename until close (restore=${restoreOriginal})`, async ({
    electronApp,
    orcaPage,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const originalName = `aaa-cli-wait-${Date.now()}`
    const movedName = `${originalName}-moved`
    const originalDirectory = path.join(testRepoPath, originalName)
    const movedDirectory = path.join(testRepoPath, movedName)
    await mkdir(originalDirectory)
    registerPostElectronShutdownCleanup(async () => {
      await rm(originalDirectory, { recursive: true, force: true })
      await rm(movedDirectory, { recursive: true, force: true })
    })
    const filePath = path.join(originalDirectory, 'prompt.txt')
    await writeFile(filePath, 'Keep editing after rename')
    await activateGoldenWorktree(orcaPage, testRepoPath, testRepoPath)
    await openFileExplorer(orcaPage)
    await orcaPage.getByRole('button', { name: 'Refresh Explorer', exact: true }).click()
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    const caller = startExternalEditorCli(userDataDir, ['file', 'edit', '--wait', filePath])
    const panel = orcaPage.locator('[data-floating-terminal-panel]')
    const explorer = orcaPage.locator('[data-orca-explorer-shell]')
    try {
      const editor = panel.locator('.monaco-editor').first()
      await expect(editor.locator('.view-lines')).toContainText('Keep editing after rename', {
        timeout: 30_000
      })
      const row = explorer
        .locator('[data-file-explorer-row]')
        .filter({ hasText: originalName })
        .first()
      await expect(row).toBeVisible()
      await row.click({ button: 'right' })
      await orcaPage.getByRole('menuitem').filter({ hasText: 'Rename' }).first().click()
      const input = explorer.getByRole('textbox').last()
      await input.fill(movedName)
      await input.press('Enter')
      await expect(panel.locator('.editor-header-path')).toContainText(movedName)
      await expect(editor.locator('.view-lines')).toContainText('Keep editing after rename')
      await editor.getByRole('textbox', { name: 'Editor content', exact: true }).focus()
      await orcaPage.keyboard.press('ControlOrMeta+A')
      await orcaPage.keyboard.insertText('Keep editing after rename and save')
      await orcaPage.keyboard.press('ControlOrMeta+S')
      const movedPath = path.join(movedDirectory, 'prompt.txt')
      await expect
        .poll(() => readFile(movedPath, 'utf8'))
        .toBe('Keep editing after rename and save')
      await captureExternalEditorEvidence(orcaPage, testInfo, 'renamed-tab-still-waiting')
      expect(caller.isPending()).toBe(true)
      if (restoreOriginal) {
        const movedRow = explorer
          .locator('[data-file-explorer-row]')
          .filter({ hasText: movedName })
          .first()
        await movedRow.click({ button: 'right' })
        await orcaPage.getByRole('menuitem').filter({ hasText: 'Rename' }).first().click()
        await input.fill(originalName)
        await input.press('Enter')
        await expect(panel.locator('.editor-header-path')).not.toContainText(movedName)
        await expect
          .poll(() => readFile(filePath, 'utf8'))
          .toBe('Keep editing after rename and save')
        expect(caller.isPending()).toBe(true)
      }
      const tab = panel.locator('[data-tab-id]').filter({ hasText: 'prompt.txt' }).last()
      await tab.hover()
      await tab.getByRole('button', { name: 'Close tab' }).click()
      await expect(editor).toHaveCount(0)
      const result = await caller.result
      if (restoreOriginal) {
        expect(result.code, result.stderr).toBe(0)
      } else {
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain('ENOENT')
      }
    } finally {
      await caller.cancel()
    }
  })
}
