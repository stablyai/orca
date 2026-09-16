import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('F2 starts inline rename on the selected explorer row', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  await expect(explorer).toBeVisible({ timeout: 15_000 })
  const row = explorer
    .locator('[data-file-explorer-row]')
    .filter({ hasText: /^README\.md$/ })
    .first()
  await expect(row).toBeVisible({ timeout: 10_000 })

  await row.click()
  await orcaPage.keyboard.press('F2')

  // The inline rename input renders inside a virtualized row wrapper; the
  // explorer's Find-files filter input sits outside them.
  const inlineInput = explorer.locator('[data-index] input')
  await expect(inlineInput).toBeVisible({ timeout: 5_000 })
  await expect(inlineInput).toHaveValue('README.md')

  // Escape cancels without touching the file
  await inlineInput.press('Escape')
  await expect(inlineInput).toHaveCount(0)
  await expect(row).toBeVisible()
})
