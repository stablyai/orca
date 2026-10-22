import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

// Why its own file: release-cut restores golden-source-control-open-diff.spec.ts from main onto
// older patch tags, which predate this menu item (#24502).
test('@golden offers to reveal a changed file in the OS file manager from its Source Control row', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'reveal-row')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)

  await waitForSessionReady(orcaPage)
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)

  const changedFile = orcaPage
    .locator('[data-testid="source-control-entry"]')
    .filter({ hasText: path.basename(GOLDEN_CHANGED_PATH) })
  await expect(changedFile).toBeVisible({ timeout: 15_000 })
  await changedFile.click({ button: 'right' })

  await expect(
    orcaPage.getByRole('menuitem', {
      name: /Reveal in Finder|Reveal in File Explorer|Open Containing Folder/
    })
  ).toBeEnabled()
})
