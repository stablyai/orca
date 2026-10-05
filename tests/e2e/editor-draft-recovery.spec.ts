import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test('checkpoints continuous typing, retains a closed buffer, and recovers an exact copy', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const original = path.join(testRepoPath, 'recovery-note.txt')
  const destination = testInfo.outputPath('recovery-note.recovered.txt')
  writeFileSync(original, 'unchanged disk baseline')
  await orcaPage.evaluate(async (filePath) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('Missing active workspace')
    }
    await state.updateSettingsOrThrow({ editorAutoSave: false })
    state.openFile({
      filePath,
      relativePath: 'recovery-note.txt',
      worktreeId: state.activeWorktreeId,
      language: 'plaintext',
      mode: 'edit'
    })
  }, original)
  const editor = orcaPage.locator('.monaco-editor').first()
  await expect(editor).toBeVisible({ timeout: 25_000 })
  await expect(editor).toContainText('unchanged disk baseline')
  await editor.click()
  await orcaPage.keyboard.press('ControlOrMeta+a')
  const readCheckpoint = () =>
    orcaPage.evaluate(async (filePath) => {
      const api = window.api.session.recovery
      const entry = (await api?.list())?.find((entry) => entry.filePath === filePath)
      return entry ? (await api?.read(entry.id))?.content : null
    }, original)
  // Establish storage readiness separately from the continuous-input assertion.
  await orcaPage.keyboard.type('ready checkpoint')
  await expect.poll(readCheckpoint, { timeout: 10_000 }).toBe('ready checkpoint')
  await orcaPage.keyboard.press('ControlOrMeta+a')
  const text = 'continuously typed unsaved text '.repeat(16)
  let typingComplete = false
  const typing = orcaPage.keyboard.type(text, { delay: 15 }).then(() => {
    typingComplete = true
  })
  await expect
    .poll(
      async () => {
        const checkpoint = await readCheckpoint()
        return checkpoint?.startsWith('continuously') ? checkpoint.length : 0
      },
      { timeout: 5_000 }
    )
    .toBeGreaterThan(10)
  expect(typingComplete).toBe(false)
  await typing
  await expect.poll(readCheckpoint).toBe(text)
  expect(readFileSync(original, 'utf8')).toBe('unchanged disk baseline')
  await orcaPage.evaluate((filePath) => {
    const state = window.__store?.getState()
    const file = state?.openFiles.find((file) => file.filePath === filePath)
    if (!file) {
      throw new Error('Missing edited buffer')
    }
    state?.closeFile(file.id)
    state?.openModal('worktree-palette')
  }, original)
  const palette = orcaPage.getByRole('dialog')
  await palette.getByRole('combobox').fill('Recover unsaved changes')
  await palette.locator('[data-value="quick-action:recover-unsaved-changes"]').click()
  const dialog = orcaPage.getByRole('dialog', { name: 'Recover unsaved changes' })
  await expect(dialog.getByRole('textbox', { name: 'Draft preview' })).toHaveValue(text)
  await expect(dialog.getByRole('button', { name: 'Discard', exact: true })).toBeEnabled()
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, destination)
  await dialog.getByRole('button', { name: 'Recover copy…' }).click()
  await expect(dialog.getByRole('status')).toContainText(destination)
  expect(readFileSync(destination, 'utf8')).toBe(text)
  expect(readFileSync(original, 'utf8')).toBe('unchanged disk baseline')
  await orcaPage.screenshot({ path: testInfo.outputPath('recovered-copy.png') })
  await orcaPage.evaluate(() => window.__store?.getState().updateSettingsOrThrow({ theme: 'dark' }))
  await expect(orcaPage.locator('html')).toHaveClass(/dark/)
  await orcaPage.screenshot({ path: testInfo.outputPath('recovered-copy-dark.png') })
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog.getByText('Discard this recovery copy?')).toBeVisible()
  await dialog.getByRole('button', { name: 'Keep', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Draft preview' })).toHaveValue(text)
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await dialog.getByRole('button', { name: 'Discard', exact: true }).click()
  await expect(dialog.getByText('No recovery drafts found.')).toBeVisible()
  expect(readFileSync(destination, 'utf8')).toBe(text)
})

test('refreshes a stale preview and exports a complete large draft with a bounded preview', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const largeText = 'large draft 😀\r\n'.repeat(30_000)
  const id = await orcaPage.evaluate(async (content) => {
    const api = window.api.session.recovery
    if (!api) {
      throw new Error('Recovery API unavailable')
    }
    const id = 'large-retained-draft'
    await api.apply([
      {
        kind: 'put',
        id,
        expectedRevision: 0,
        state: 'retained',
        content,
        metadata: {
          hostId: 'ssh:missing-host',
          worktreeId: 'removed-workspace',
          filePath: '/remote/large.txt',
          relativePath: 'large.txt',
          language: 'plaintext',
          bufferKind: 'edit'
        }
      }
    ])
    window.__store?.getState().openModal('editor-recovery')
    return id
  }, largeText)
  const dialog = orcaPage.getByRole('dialog', { name: 'Recover unsaved changes' })
  const preview = dialog.getByRole('textbox', { name: 'Draft preview' })
  await expect(preview).toHaveValue(largeText.slice(0, 100_000).replaceAll('\r\n', '\n'))
  await expect(
    dialog.getByText('The preview is shortened. Recovery includes the complete draft.')
  ).toBeVisible()
  const updated = `${largeText}newest ending`
  await orcaPage.evaluate(
    async ({ id, content }) => {
      const api = window.api.session.recovery
      const draft = await api?.read(id)
      if (!api || !draft) {
        throw new Error('Missing recovery draft')
      }
      await api.apply([
        {
          kind: 'put',
          id,
          expectedRevision: draft.revision,
          state: 'retained',
          content,
          metadata: draft
        }
      ])
    },
    { id, content: updated }
  )
  const destination = testInfo.outputPath('large.recovered.txt')
  await electronApp.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath })
  }, destination)
  await dialog.getByRole('button', { name: 'Recover copy…' }).click()
  await expect(dialog.getByRole('alert')).toContainText('draft changed')
  await dialog.getByRole('button', { name: 'Refresh drafts' }).click()
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await expect(preview).toHaveValue(updated.slice(0, 100_000).replaceAll('\r\n', '\n'))
  await dialog.getByRole('button', { name: 'Recover copy…' }).click()
  await expect(dialog.getByRole('status')).toContainText(destination)
  expect(readFileSync(destination, 'utf8')).toBe(updated)
})
