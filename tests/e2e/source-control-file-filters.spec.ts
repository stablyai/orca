import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

/** Captures only Source Control so terminal prompts and other workspace details stay private. */
async function captureFileFilters(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const box = await page.getByTestId('source-control-panel').boundingBox()
  if (!box) {
    throw new Error('Source Control panel is not rendered')
  }
  await page.mouse.move(box.x + 2, box.y + box.height - 2)
  await testInfo.attach(name, {
    body: await page.screenshot({
      clip: { ...box, height: Math.min(box.height, 560) },
      animations: 'disabled'
    }),
    contentType: 'image/png'
  })
}

test('filters Source Control by extension and gitignore groups without changing Git status', async ({
  electronApp,
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'file-filters')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  seedGoldenSourceEdit(fixture.worktreePath)
  for (const name of ['ordinary.snap', 'important.snap', 'notes.md']) {
    writeFileSync(path.join(fixture.worktreePath, name), 'fixture\n')
  }
  writeFileSync(
    path.join(fixture.worktreePath, 'orca.yaml'),
    `sourceControl:
  fileGroups:
    - name: Snapshots
      patterns: ['*.snap', '!important.snap']
`
  )
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ uiLanguage: 'en' })
  })
  await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
  const rows = orcaPage.getByTestId('source-control-entry')
  await expect(rows).toHaveCount(5)
  const commits = orcaPage.getByRole('button', { name: 'Commits', exact: true })
  await expect(commits).toBeVisible()
  // The desktop remains hidden; Playwright input and screenshots use CDP.
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
  await captureFileFilters(orcaPage, testInfo, 'before-filters')

  const trigger = orcaPage.getByRole('button', { name: 'Filter files by extension or group' })
  await trigger.click()
  await orcaPage.getByRole('menuitemcheckbox', { name: 'Snapshots', exact: true }).click()
  await expect(orcaPage.getByRole('menuitemcheckbox', { name: 'All groups' })).toBeChecked()
  await orcaPage.getByRole('menuitemcheckbox', { name: '.md 1', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: 'ordinary.snap' })).toHaveCount(0)
  await expect(rows.filter({ hasText: 'important.snap' })).toBeVisible()
  await expect(orcaPage.getByText('Hidden files: 2', { exact: true })).toBeVisible()
  await expect(commits).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: 'Stage all', exact: true })).toHaveCount(0)
  await expect(orcaPage.getByRole('button', { name: 'Stage All', exact: true })).toBeVisible()
  await captureFileFilters(orcaPage, testInfo, 'after-filters')
  await trigger.click()
  await captureFileFilters(orcaPage, testInfo, 'filter-menu')
  await orcaPage.keyboard.press('Escape')

  await orcaPage.getByRole('button', { name: 'More source control actions' }).click()
  await orcaPage.getByRole('menuitem', { name: /View as (list|tree)/ }).click()
  await expect(rows).toHaveCount(3)
  await orcaPage.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await expect(rows).toHaveCount(5)

  await trigger.click()
  await orcaPage.getByRole('menuitemcheckbox', { name: 'All extensions', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(rows).toHaveCount(0)
  await expect(orcaPage.getByText('Hidden files: 5', { exact: true })).toBeVisible()
  await expect(orcaPage.getByText('No matching files', { exact: true })).toBeVisible()
  await expect(commits).toBeVisible()
  await expect(orcaPage.getByText('No changes on this branch', { exact: true })).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'Reset filters', exact: true }).click()
  await expect(rows).toHaveCount(5)
  const status = await orcaPage.evaluate(
    async (worktreePath) => window.api.git.status({ worktreePath }),
    fixture.worktreePath
  )
  expect(status.entries).toHaveLength(5)
  expect(status.entries.some((entry) => entry.area === 'staged')).toBe(false)

  await trigger.click()
  await orcaPage.getByRole('menuitemcheckbox', { name: '.snap 2', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await orcaPage.getByRole('button', { name: 'Stage All', exact: true }).click()
  await expect
    .poll(async () => {
      const staged = await orcaPage.evaluate(
        async (worktreePath) => window.api.git.status({ worktreePath }),
        fixture.worktreePath
      )
      return staged.entries.filter((entry) => entry.area === 'staged').length
    })
    .toBe(5)
})
