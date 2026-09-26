import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { openFileExplorer } from './helpers/file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

// Why: useRuntimeFileListForWorktree scopes listings/loading to a request key so a
// query change never shows the previous listing or a stale "no results" flash.
// Unit tests pin the intermediate hook renders; these specs pin the user-visible
// wiring (filter input -> rows / "No files match this filter") against regressions.
function rowByName(explorer: Locator, page: Page, name: string): Locator {
  return explorer
    .locator('[data-file-explorer-row]')
    .filter({ has: page.locator('[data-file-explorer-row-name]', { hasText: name }) })
}

test('name filter narrows to the matching file', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const input = orcaPage.getByPlaceholder('Find files')
  await expect(input).toBeVisible({ timeout: 10_000 })

  await input.fill('package.')
  await expect(rowByName(explorer, orcaPage, 'package.json').first()).toBeVisible({
    timeout: 10_000
  })
  // Why no absent-file assertion here: the seeded repo's contents decide what a
  // non-match is, and that made this spec fail on rows unrelated to the filter.
  // True no-match behavior is pinned by the next spec.
  await expect(explorer.getByText('No files match this filter')).toHaveCount(0)
})

test('name filter shows the empty message only for a true no-match', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await openFileExplorer(orcaPage)

  const explorer = orcaPage.locator('[data-orca-explorer-shell]')
  await expect(explorer).toBeVisible({ timeout: 10_000 })
  const input = orcaPage.getByPlaceholder('Find files')
  await expect(input).toBeVisible({ timeout: 10_000 })

  await input.fill('zz-no-such-file-12345')
  await expect(explorer.getByText('No files match this filter')).toBeVisible({ timeout: 10_000 })

  await input.fill('')
  await expect(rowByName(explorer, orcaPage, 'README.md').first()).toBeVisible({
    timeout: 10_000
  })
})
