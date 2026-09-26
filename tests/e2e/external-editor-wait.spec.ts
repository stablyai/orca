import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  captureExternalEditorEvidence,
  startExternalEditorCli
} from './helpers/external-editor-cli'

test.use({ seedTestRepo: false })

for (const theme of ['light', 'dark'] as const) {
  test(`external editor waits for a saved tab to close (${theme})`, async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'orca-external-editor-e2e-'))
    const filePath = path.join(scratch, 'temporary-prompt.md')
    await writeFile(filePath, '# Original prompt\n\nKeep **literal** Markdown and $5.\n')
    const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
    await orcaPage.evaluate(async (theme) => {
      await window.__store?.getState().updateSettings({ theme, editorAutoSave: false })
    }, theme)
    const before = startExternalEditorCli(userDataDir, ['file', 'open', '--wait', filePath])
    expect((await before.result).code).toBe(1)
    await captureExternalEditorEvidence(orcaPage, testInfo, 'before-existing-file-open')
    const caller = startExternalEditorCli(userDataDir, ['file', 'edit', '--wait', filePath])
    try {
      const panel = orcaPage.locator('[data-floating-terminal-panel]')
      const editor = panel.locator('.monaco-editor').first()
      await expect(editor).toBeVisible({ timeout: 30_000 })
      await expect(editor.locator('.view-lines')).toContainText('Original prompt')
      await expect(panel.locator('.rich-markdown-editor')).toHaveCount(0)
      expect(caller.isPending()).toBe(true)
      await captureExternalEditorEvidence(orcaPage, testInfo, 'after-source-editor-open')
      await editor.locator('.view-lines').click()
      await orcaPage.keyboard.press('ControlOrMeta+A')
      const edited = '# Edited prompt\n\n日本語 and **literal** Markdown with $5.\n'
      await orcaPage.keyboard.insertText(edited)
      const tab = panel.locator('[data-tab-id]').filter({ hasText: 'temporary-prompt.md' }).last()
      await tab.hover()
      await tab.getByRole('button', { name: 'Close tab' }).click()
      const dialog = orcaPage.getByRole('dialog', { name: 'Unsaved Changes' })
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toBeHidden()
      await expect(editor).toBeVisible()
      expect(caller.isPending()).toBe(true)
      await editor.getByRole('textbox', { name: 'Editor content', exact: true }).focus()
      await expect(
        editor.getByRole('textbox', { name: 'Editor content', exact: true })
      ).toBeFocused()
      await orcaPage.keyboard.press('ControlOrMeta+S')
      await expect.poll(() => readFile(filePath, 'utf8')).toBe(edited)
      expect(caller.isPending()).toBe(true)
      await captureExternalEditorEvidence(orcaPage, testInfo, 'after-save-still-waiting')
      expect(caller.isPending()).toBe(true)
      await tab.hover()
      await tab.getByRole('button', { name: 'Close tab' }).click()
      await expect(editor).toHaveCount(0)
      const result = await caller.result
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('Closed')
      expect(await readFile(filePath, 'utf8')).toBe(edited)
      await testInfo.attach('cli-completion', { body: result.stdout, contentType: 'text/plain' })
      expect(
        await electronApp.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((window) => window.isVisible())
        )
      ).toBe(false)
    } finally {
      await caller.cancel()
      await rm(scratch, { recursive: true, force: true })
    }
  })
}

test('external editor reports renderer reload as failure', async ({ electronApp, orcaPage }) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'orca-external-editor-reload-'))
  const filePath = path.join(scratch, 'reload-prompt.txt')
  await writeFile(filePath, 'Keep this prompt')
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const caller = startExternalEditorCli(userDataDir, ['file', 'edit', '--wait', filePath])
  try {
    await expect(orcaPage.locator('[data-floating-terminal-panel] .monaco-editor')).toBeVisible({
      timeout: 30_000
    })
    await orcaPage.reload()
    const result = await caller.result
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('renderer_unavailable')
    expect(await readFile(filePath, 'utf8')).toBe('Keep this prompt')
  } finally {
    await caller.cancel()
    await rm(scratch, { recursive: true, force: true })
  }
})

test('interrupting the caller leaves its file open and unchanged', async ({
  electronApp,
  orcaPage
}) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'orca-external-editor-cancel-'))
  const filePath = path.join(scratch, 'cancel-prompt.txt')
  await writeFile(filePath, 'Keep this prompt after interruption')
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const caller = startExternalEditorCli(userDataDir, ['file', 'edit', '--wait', filePath])
  try {
    const editor = orcaPage.locator('[data-floating-terminal-panel] .monaco-editor')
    await expect(editor).toBeVisible({ timeout: 30_000 })
    await expect(editor.locator('.view-lines')).toContainText('Keep this prompt after interruption')
    expect(caller.isPending()).toBe(true)
    await caller.cancel()
    await expect(editor).toBeVisible()
    expect(await readFile(filePath, 'utf8')).toBe('Keep this prompt after interruption')
    const panel = orcaPage.locator('[data-floating-terminal-panel]')
    const tab = panel.locator('[data-tab-id]').filter({ hasText: 'cancel-prompt.txt' }).last()
    await tab.hover()
    await tab.getByRole('button', { name: 'Close tab' }).click()
    await expect(editor).toHaveCount(0)
  } finally {
    await caller.cancel()
    await rm(scratch, { recursive: true, force: true })
  }
})
