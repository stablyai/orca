/**
 * E2E: Quick Open (Cmd+P) seeds its empty-query order with recent files.
 *
 * Opens several editor files, closes one, then opens Quick Open with no query
 * and asserts the recently opened/closed files lead the list (instead of the
 * arbitrary file-listing walk order). Captures a screenshot for the PR demo.
 */

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  ensureTerminalVisible
} from './helpers/store'

test.describe('Quick Open recency', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('empty-query Quick Open leads with recent open + closed files', async ({
    orcaPage
  }, testInfo) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    await orcaPage.evaluate((wtId) => {
      const store = window.__store!
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((w) => w.id === wtId)
      const base = worktree!.path
      const open = (rel: string, language: string): void =>
        state.openFile({
          filePath: `${base}/${rel}`,
          relativePath: rel,
          worktreeId: wtId,
          language,
          mode: 'edit'
        })
      open('README.md', 'markdown')
      open('package.json', 'json')
      open('CLAUDE.md', 'markdown')
      state.closeFile(`${base}/CLAUDE.md`)
      open('src/index.ts', 'typescript')
      state.openModal('quick-open')
    }, worktreeId)

    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // The three most recent files (2 open + 1 closed) lead the empty-query list,
    // in most-recent-first order; the active file (index.ts) is excluded.
    const items = dialog.locator('[cmdk-item]')
    await expect(items.nth(0)).toContainText('package.json')
    await expect(items.nth(1)).toContainText('README.md')
    await expect(items.nth(2)).toContainText('CLAUDE.md')

    await testInfo.attach('quick-open-recency', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
  })
})
