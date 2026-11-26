import { realpathSync } from 'node:fs'
import path from 'node:path'
import { test } from '../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  GOLDEN_REMOVED_LINE,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './golden-source-control'
import { waitForSessionReady } from '../desktop/renderer-probes/store'

test('@golden opens an unstaged file diff from Source Control', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'open-diff')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  const changedFile = orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
  await expect(changedFile).toBeVisible({ timeout: 15_000 })
  await changedFile.click()

  await expect(orcaPage.locator('.monaco-diff-editor')).toBeVisible({ timeout: 20_000 })
  await expect(
    orcaPage
      .locator('.original-in-monaco-diff-editor .view-line')
      .filter({ hasText: GOLDEN_REMOVED_LINE })
  ).toBeVisible()
  await expect(
    orcaPage
      .locator('.modified-in-monaco-diff-editor .view-line')
      .filter({ hasText: GOLDEN_ADDED_LINE })
  ).toBeVisible()
  await expect(orcaPage.locator('.editor-header-path').first()).toHaveAttribute(
    'title',
    `${realpathSync(path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)).replaceAll('\\', '/')} (diff)`
  )

  const probe = orcaPage.getByRole('button', { name: /Source Control/ })
  await probe.focus()
  await expect(probe).toBeFocused()
})
