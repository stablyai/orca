import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { getBrowserTabs, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('the File Explorer shortcut opens the focused HTML file in the Orca Browser', async ({
  orcaPage,
  seededRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const name = 'shortcut-report.html'
  const filePath = path.join(seededRepoPath, name)
  writeFileSync(filePath, '<!doctype html><title>Shortcut report</title><h1>Report</h1>')
  registerPostElectronShutdownCleanup(async () => rmSync(filePath, { force: true }))
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  const row = explorer
    .locator('[data-file-explorer-row]')
    .filter({ has: orcaPage.locator('[data-file-explorer-row-name]', { hasText: name }) })
  await expect(row.first()).toBeVisible({ timeout: 15_000 })
  await row.first().focus()
  await row.first().click({ button: 'right' })
  const menuItem = orcaPage.getByRole('menuitem', { name: /Open in Orca Browser/ })
  await expect(menuItem).toContainText(process.platform === 'darwin' ? '⌥⌘B' : 'Alt+Shift+B')
  await orcaPage.getByRole('menu').screenshot({ path: testInfo.outputPath('context-menu.png') })
  await orcaPage.keyboard.press('Escape')
  await row.first().focus()
  const before = (await getBrowserTabs(orcaPage, worktreeId)).length

  const isMac = process.platform === 'darwin'
  await orcaPage.keyboard.press(isMac ? 'Meta+Alt+KeyB' : 'Alt+Shift+KeyB')

  await expect
    .poll(async () => (await getBrowserTabs(orcaPage, worktreeId)).length, { timeout: 10_000 })
    .toBe(before + 1)
  const opened = (await getBrowserTabs(orcaPage, worktreeId)).at(-1)
  expect(opened?.url).toContain(name)
  await orcaPage.screenshot({ path: testInfo.outputPath('browser-tab.png') })
})
