import { expect, test } from './helpers/mcode-app'
import { openFileExplorer } from './helpers/file-explorer'
import { pressShortcut } from './helpers/shortcuts'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('Explorer-opened Markdown accepts the find shortcut without a document click', async ({
  mcodePage
}) => {
  await waitForSessionReady(mcodePage)
  await waitForActiveWorktree(mcodePage)
  await openFileExplorer(mcodePage)

  const readmeRow = mcodePage.locator('[data-file-explorer-row]').filter({ hasText: 'README.md' })
  await expect(readmeRow).toBeVisible({ timeout: 10_000 })
  await readmeRow.focus()
  await readmeRow.click()

  await expect(mcodePage.locator('.rich-markdown-editor')).toBeVisible({ timeout: 25_000 })
  await pressShortcut(mcodePage, 'f')

  await expect(
    mcodePage.getByRole('textbox', { name: 'Find in rich markdown editor' })
  ).toBeVisible()
})
