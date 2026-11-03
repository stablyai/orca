import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'

test('writable file editor uses vim motions, :w, and keeps undo when vim turns off', async ({
  orcaPage,
  seededRepoPath
}) => {
  const name = 'vim-keybindings.txt'
  const filePath = path.join(seededRepoPath, name)
  writeFileSync(filePath, 'hello\n')

  await orcaPage.evaluate(
    async ({ filePath: openedPath, relativePath }) => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Missing vim editor workspace')
      }
      await state.updateSettings({ editorAutoSave: false, editorKeybindings: 'vim' })
      state.openFile(
        {
          filePath: openedPath,
          relativePath,
          worktreeId: state.activeWorktreeId,
          language: 'plaintext',
          mode: 'edit'
        },
        { preview: false }
      )
    },
    { filePath, relativePath: name }
  )

  const status = orcaPage.locator('[data-vim-status]')
  const editor = orcaPage.locator('.monaco-editor').last()
  await expect(status).toContainText('--NORMAL--')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue()))
    .toBe('hello\n')

  // Why: a center click lands past the short line; Home puts the cursor on h before x.
  await editor.locator('.view-line').first().click()
  await orcaPage.keyboard.press('Home')
  await orcaPage.keyboard.press('x')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue()))
    .toBe('ello\n')

  await orcaPage.keyboard.press('i')
  await orcaPage.keyboard.press('Z')
  await orcaPage.keyboard.press('Escape')
  await expect(status).toContainText('--NORMAL--')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue()))
    .toBe('Zello\n')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().canUndo ?? false))
    .toBe(true)

  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => readFileSync(filePath, 'utf8')).toBe('Zello\n')

  await orcaPage.keyboard.press('o')
  await orcaPage.keyboard.press('Escape')
  await orcaPage.keyboard.press(':')
  await orcaPage.keyboard.press('w')
  await orcaPage.keyboard.press('Enter')
  await expect.poll(() => readFileSync(filePath, 'utf8')).not.toBe('Zello\n')
  await expect
    .poll(() => readFileSync(filePath, 'utf8'))
    .toBe(await orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue() ?? ''))

  await orcaPage.keyboard.press('ControlOrMeta+f')
  const findWidget = editor.locator('.find-widget')
  await expect(findWidget).toHaveAttribute('aria-hidden', 'false')
  await orcaPage.keyboard.press('Escape')
  await expect(findWidget).toHaveAttribute('aria-hidden', 'true')
  await expect(status).toContainText('--NORMAL--')

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ editorKeybindings: 'default' })
  })
  await expect(status).toHaveCount(0)
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().canUndo ?? false))
    .toBe(true)

  const beforeInsert = await orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue() ?? '')
  await editor.click()
  await orcaPage.keyboard.press('q')
  await expect
    .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue() ?? ''))
    .toBe(`${beforeInsert}q`)
  await orcaPage.keyboard.press('ControlOrMeta+z')
  const afterUndo = await orcaPage.evaluate(() => window.__monacoEditorE2E?.getValue() ?? '')
  expect(afterUndo).toBe(beforeInsert)
  expect(afterUndo).toContain('Zello')
})
