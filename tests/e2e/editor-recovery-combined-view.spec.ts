import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('protects combined-view edits, retires saved text, and retains a closed section', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const source = path.join(testRepoPath, 'src', 'index.ts')
  const baseline = '// combined-view disk baseline\n'
  writeFileSync(source, baseline)
  const parentId = await orcaPage.evaluate(async (root) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing active workspace')
    }
    await state.updateSettingsOrThrow({ editorAutoSave: false })
    const status = await window.api.git.status({ worktreePath: root })
    state.setGitStatus(state.activeWorktreeId, status)
    state.openAllDiffs(
      state.activeWorktreeId,
      root,
      undefined,
      'unstaged',
      status.entries.filter((entry) => entry.area === 'unstaged' && entry.path === 'src/index.ts')
    )
    const id = window.__store?.getState().activeFileId
    if (!id) {
      throw new Error('Missing combined-view tab')
    }
    return id
  }, testRepoPath)
  const editor = orcaPage.locator('.combined-diff-scroll-container .editor.modified').first()
  await expect(editor).toBeVisible({ timeout: 25_000 })
  await expect(editor).toContainText('combined-view disk baseline')
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+a')
  const savedText = '// saved combined-view edit\n'
  await orcaPage.keyboard.type(savedText)
  await expect
    .poll(() =>
      orcaPage.evaluate(async (filePath) => {
        const api = window.api.session.recovery
        const row = (await api?.list())?.find((row) => row.filePath === filePath)
        return row ? (await api?.read(row.id))?.content : null
      }, source)
    )
    .toBe(savedText)
  expect(readFileSync(source, 'utf8')).toBe(baseline)
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect.poll(() => readFileSync(source, 'utf8')).toBe(savedText)
  await expect
    .poll(() =>
      orcaPage.evaluate(
        async (filePath) =>
          (await window.api.session.recovery?.list())?.filter((row) => row.filePath === filePath)
            .length,
        source
      )
    )
    .toBe(0)

  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+a')
  const unsavedText = '// unsaved section after a successful save\n'
  await orcaPage.keyboard.type(unsavedText)
  await orcaPage.evaluate((id) => {
    const state = window.__store?.getState()
    state?.closeFile(id)
    state?.openModal('editor-recovery')
  }, parentId)
  const dialog = orcaPage.getByRole('dialog', { name: 'Recover unsaved changes' })
  await expect(dialog.getByRole('textbox', { name: 'Draft preview' })).toHaveValue(unsavedText)
  await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toBeEnabled()
  await expect
    .poll(() =>
      orcaPage.evaluate(
        async (filePath) =>
          (await window.api.session.recovery?.list())?.find((row) => row.filePath === filePath)
            ?.state,
        source
      )
    )
    .toBe('retained')
  const destination = testInfo.outputPath('combined-section.recovered.ts')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, destination)
  await dialog.getByRole('button', { name: 'Recover copy…' }).click()
  await expect(dialog.getByRole('status')).toContainText(destination)
  expect(readFileSync(destination, 'utf8')).toBe(unsavedText)
  expect(readFileSync(source, 'utf8')).toBe(savedText)
})
