import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { waitForSessionReady } from './helpers/store'

test('restores an unsaved buffer after a hard kill and preserves a subsequent disk change', async ({
  testRepoPath
}, testInfo) => {
  const session = createRestartSession(testInfo)
  const filePath = path.join(testRepoPath, 'crash-recovery-note.txt')
  const draft = 'unsaved buffer at the acknowledged checkpoint 😀'
  writeFileSync(filePath, 'original disk text')
  let launched = await session.launch()
  try {
    const worktreeId = await attachRepoAndOpenTerminal(launched.page, testRepoPath)
    await waitForSessionReady(launched.page)
    await launched.page.evaluate(
      async ({ filePath, worktreeId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Store unavailable')
        }
        await state.updateSettingsOrThrow({ editorAutoSave: false })
        state.openFile({
          filePath,
          worktreeId,
          relativePath: 'crash-recovery-note.txt',
          language: 'plaintext',
          mode: 'edit'
        })
      },
      { filePath, worktreeId }
    )
    const editor = launched.page.locator('.monaco-editor').first()
    await expect(editor).toBeVisible({ timeout: 25_000 })
    await expect(editor).toContainText('original disk text')
    await editor.click()
    await launched.page.keyboard.press('ControlOrMeta+a')
    await launched.page.keyboard.insertText(draft)
    await expect
      .poll(() =>
        launched.page.evaluate(async (filePath) => {
          const api = window.api.session.recovery
          const entry = (await api?.list())?.find((entry) => entry.filePath === filePath)
          return entry ? (await api?.read(entry.id))?.content : null
        }, filePath)
      )
      .toBe(draft)
    await launched.page.evaluate(() => window.api.session.flush())
    const exited = once(launched.app.process(), 'exit')
    launched.app.process().kill('SIGKILL')
    await exited
    writeFileSync(filePath, 'external disk edit while the app was closed')
    launched = await session.launch()
    await waitForSessionReady(launched.page)
    await expect
      .poll(
        () =>
          launched.page.evaluate((filePath) => {
            const state = window.__store?.getState()
            const file = state?.openFiles.find((file) => file.filePath === filePath)
            return (
              file && {
                content: state?.editorDrafts[file.id],
                dirty: file.isDirty,
                conflict: file.externalMutation
              }
            )
          }, filePath),
        { timeout: 25_000 }
      )
      .toEqual({ content: draft, dirty: true, conflict: 'changed' })
    await launched.page.evaluate(() =>
      window.__store
        ?.getState()
        .updateSettingsOrThrow({ editorAutoSave: true, editorAutoSaveDelayMs: 100 })
    )
    await launched.page.waitForTimeout(1_000)
    expect(readFileSync(filePath, 'utf8')).toBe('external disk edit while the app was closed')
    await launched.page.screenshot({ path: testInfo.outputPath('restored-disk-conflict.png') })
  } finally {
    await session.close(launched.app).catch(() => {})
    await session.dispose()
  }
})
