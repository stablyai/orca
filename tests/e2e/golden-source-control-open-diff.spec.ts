import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_ADDED_LINE,
  GOLDEN_CHANGED_PATH,
  GOLDEN_REMOVED_LINE,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

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

  await expect(orcaPage.locator('diffs-container')).toBeVisible({ timeout: 20_000 })
  await expect(
    orcaPage
      .locator('diffs-container [data-content] [data-line-type="change-deletion"]')
      .filter({ hasText: GOLDEN_REMOVED_LINE })
  ).toBeVisible()
  await expect(
    orcaPage
      .locator('diffs-container [data-content] [data-line-type="change-addition"]')
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

test('diff editing preserves immediate input, saves, and undoes after a render update', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'diff-edit')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)
  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  await orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
    .click()
  const changedLine = orcaPage
    .locator('diffs-container [data-content] [data-line-type="change-addition"]')
    .filter({ hasText: GOLDEN_ADDED_LINE })
  await changedLine.click({ timeout: 20_000 })
  await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
  await orcaPage.keyboard.type(' // immediate input', { delay: 20 })
  await expect(changedLine).toHaveText(`${GOLDEN_ADDED_LINE} // immediate input`)
  await orcaPage.keyboard.press('ControlOrMeta+s')
  const diskPath = path.join(fixture.worktreePath, GOLDEN_CHANGED_PATH)
  await expect
    .poll(() => readFileSync(diskPath, 'utf8'))
    .toContain(`${GOLDEN_ADDED_LINE} // immediate input`)
  // A later edit must remain in the same document after the worker settles.
  await orcaPage.waitForTimeout(600)
  await orcaPage.keyboard.type(' continued', { delay: 20 })
  await expect(changedLine).toHaveText(`${GOLDEN_ADDED_LINE} // immediate input continued`)
  await orcaPage.waitForTimeout(600)
  await orcaPage.keyboard.press('ControlOrMeta+z')
  await orcaPage.keyboard.press('ControlOrMeta+s')
  await expect(changedLine).toHaveText(`${GOLDEN_ADDED_LINE} // immediate input`)
  await expect
    .poll(() => readFileSync(diskPath, 'utf8'))
    .toContain(`${GOLDEN_ADDED_LINE} // immediate input\n`)
})
