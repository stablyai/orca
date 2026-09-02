import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH,
  GOLDEN_GIT_AUTHOR_EMAIL,
  GOLDEN_GIT_AUTHOR_NAME,
  installPassingNodePreCommitHook,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('@golden stages and commits a file through Source Control', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'commit')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)
  const hookMarkerPath = installPassingNodePreCommitHook(fixture)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  const unstagedRow = orcaPage
    .locator('[data-testid="source-control-entry"][data-source-control-area="unstaged"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
  await expect(unstagedRow).toBeVisible()
  const stageButton = unstagedRow.getByRole('button', { name: 'Stage' })
  await stageButton.focus()
  await stageButton.press('Enter')
  await expect(unstagedRow).toHaveCount(0, { timeout: 10_000 })

  const stagedRow = orcaPage
    .locator('[data-testid="source-control-entry"][data-source-control-area="staged"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
  await expect(stagedRow).toBeVisible({ timeout: 10_000 })
  await orcaPage.getByRole('textbox', { name: 'Commit message' }).fill('test: golden daily loop')
  await orcaPage.getByRole('button', { name: 'Commit', exact: true }).click()

  await expect(stagedRow).toHaveCount(0, { timeout: 20_000 })
  await expect
    .poll(
      () =>
        execFileSync('git', ['status', '--porcelain'], {
          cwd: fixture.worktreePath,
          encoding: 'utf8'
        }),
      { timeout: 20_000, message: 'Golden commit worktree did not become clean' }
    )
    .toBe('')
  expect(
    execFileSync('git', ['show', '-s', '--format=%an%n%ae%n%s', 'HEAD'], {
      cwd: fixture.worktreePath,
      encoding: 'utf8'
    }).trim()
  ).toBe(`${GOLDEN_GIT_AUTHOR_NAME}\n${GOLDEN_GIT_AUTHOR_EMAIL}\ntest: golden daily loop`)
  await expect.poll(() => existsSync(hookMarkerPath), { timeout: 20_000 }).toBe(true)
  await expect(
    orcaPage.locator('[data-sonner-toast]').filter({ hasText: /node|command not found|cmd\.exe/i })
  ).toHaveCount(0)
})
