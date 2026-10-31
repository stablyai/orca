import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

test('search view replaces one match, then every match', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'search-replace')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const firstPath = path.join(fixture.worktreePath, 'replace-first.txt')
  const secondPath = path.join(fixture.worktreePath, 'replace-second.txt')
  writeFileSync(firstPath, 'const zebraValue = 1\nconst zebraTotal = zebraValue + 1\n')
  writeFileSync(secondPath, 'ZebraCount\n')

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  await orcaPage.evaluate(() => window.__store?.getState().showRightSidebarSearch())

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  await explorer.getByRole('textbox', { name: 'Search files' }).fill('zebra')
  await expect(explorer.getByText('4 results in 2 files')).toBeVisible({ timeout: 20_000 })

  await explorer.getByRole('button', { name: 'Toggle Replace' }).click()
  const replaceInput = explorer.getByRole('textbox', { name: 'Replace' })
  await expect(replaceInput).toBeFocused()
  await replaceInput.fill('lion')
  await explorer.getByRole('button', { name: 'Preserve Case' }).click()
  await expect(explorer.getByText('Lion', { exact: true })).toBeVisible()

  const firstMatch = explorer.getByRole('button', { name: /^1\s*const zebra/ })
  await firstMatch.hover()
  await firstMatch.locator('xpath=..').getByRole('button', { name: 'Replace', exact: true }).click()
  await expect
    .poll(() => readFileSync(firstPath, 'utf8'))
    .toBe('const lionValue = 1\nconst zebraTotal = zebraValue + 1\n')
  await expect(explorer.getByText('3 results in 2 files')).toBeVisible({ timeout: 20_000 })

  await explorer.getByRole('button', { name: 'Replace All', exact: true }).first().click()
  const dialog = orcaPage.getByRole('dialog')
  await expect(dialog).toContainText("Replace 3 occurrences across 2 files with 'lion'?")
  await dialog.getByRole('button', { name: 'Replace' }).click()

  await expect
    .poll(() => readFileSync(firstPath, 'utf8'))
    .toBe('const lionValue = 1\nconst lionTotal = lionValue + 1\n')
  expect(readFileSync(secondPath, 'utf8')).toBe('LionCount\n')
  await expect(explorer.getByText('4 results in 2 files')).toHaveCount(0)
})
