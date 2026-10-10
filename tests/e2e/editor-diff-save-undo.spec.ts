import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('keeps editable diff Undo after save and does not restore a discarded edit', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'diff-save-undo')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)
  const filePath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)
  const original = readFileSync(filePath, 'utf8')
  const edited = 'X'

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  await orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
    .click()

  const modified = orcaPage.locator('.modified-in-monaco-diff-editor')
  const lines = modified.locator('.view-lines:not(.line-delete)')
  await expect(lines).toContainText(GOLDEN_ADDED_LINE, { timeout: 25_000 })
  const fileTab = orcaPage
    .locator('[data-tab-id]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
    .last()
  const close = fileTab.getByRole('button', { name: 'Close tab' })

  await modified.click()
  await orcaPage.keyboard.press('ControlOrMeta+A')
  await orcaPage.keyboard.insertText(edited)
  await expect(lines).toContainText(edited)
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(edited)
  await expect(close).not.toHaveClass(/(?:^|\s)hidden(?:\s|$)/)
  await orcaPage.screenshot({ path: testInfo.outputPath('diff-after-save.png') })

  await orcaPage.keyboard.press('ControlOrMeta+Z')
  await expect(lines).toContainText(GOLDEN_ADDED_LINE)
  await expect(lines).not.toContainText(edited)
  await orcaPage.screenshot({ path: testInfo.outputPath('diff-after-undo.png') })

  await orcaPage.keyboard.press('ControlOrMeta+Shift+Z')
  await expect(lines).toContainText(edited)
  await orcaPage.keyboard.press('ControlOrMeta+A')
  await orcaPage.keyboard.insertText(original)
  await orcaPage.keyboard.press('ControlOrMeta+S')
  await expect.poll(() => readFileSync(filePath, 'utf8')).toBe(original)
  await expect(close).not.toHaveClass(/(?:^|\s)hidden(?:\s|$)/)
  await expect(lines).toContainText(GOLDEN_ADDED_LINE)
  await expect(lines).not.toContainText(edited)
  await orcaPage.screenshot({ path: testInfo.outputPath('diff-manual-revert-saved.png') })
})
