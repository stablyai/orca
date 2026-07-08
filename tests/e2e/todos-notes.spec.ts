import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const TODO_BODY = 'Ship the notes hybrid'
const PAGE_MARKDOWN = [
  '## Plan',
  '',
  '- top',
  '  - nested',
  '',
  'See [docs](https://example.com)'
].join('\n')
const UPDATE_BODY = 'Reviewed the [PR](https://example.com/pr)'

/**
 * Activate a worktree, open the right sidebar, and switch to the Todos tab.
 * Tab switch is store-driven because the activity-bar click races sidebar mount.
 */
async function openTodos(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate((targetWorktreeId) => {
    const state = window.__store?.getState()
    state?.setActiveWorktree(targetWorktreeId)
    state?.setRightSidebarOpen(true)
  }, worktreeId)
  // Why: the click mounts the panel; the tab occasionally reverts to 'explorer'
  // as the sidebar settles, so re-apply 'todos' through the store each poll
  // iteration until it sticks (store-driven correction per flaky-nav guidance).
  await page.getByRole('button', { name: 'Todos' }).first().click()
  await expect
    .poll(
      async () => {
        const tab = await page.evaluate(() => window.__store?.getState().rightSidebarTab)
        if (tab !== 'todos') {
          await page.evaluate(() => window.__store?.getState().setRightSidebarTab('todos'))
        }
        return page.evaluate(() => window.__store?.getState().rightSidebarTab)
      },
      { timeout: 5_000 }
    )
    .toBe('todos')
}

test.describe('Todo notes page + updates hybrid', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('writes a markdown page, adds a timeline update, and persists across reload', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, worktreeId)

    const section = orcaPage.getByTestId('todo-section-worktree')
    await expect(section).toBeVisible({ timeout: 10_000 })

    // ── Add a todo ──────────────────────────────────────────────────────
    const input = section.getByPlaceholder('Add a todo')
    await input.fill(TODO_BODY)
    await input.press('Enter')

    const row = section.getByTestId('todo-row').filter({ hasText: TODO_BODY })
    await expect(row).toBeVisible()
    // No content yet → no update count badge.
    await expect(row.getByTestId('todo-notes-count')).toHaveCount(0)

    // ── Expand: opens straight into the page editor (no content yet) ─────
    await row.hover()
    await row.getByTestId('todo-notes-toggle').click()

    const docInput = section.getByTestId('todo-notes-doc-input')
    await expect(docInput).toBeVisible()
    await docInput.fill(PAGE_MARKDOWN)
    // Blur the page editor (focus the update composer) → autosave + render.
    await section.getByTestId('todo-note-add').click()

    // ── Page renders as markdown (sub-list + link) ──────────────────────
    const preview = section.getByTestId('todo-notes-doc-preview')
    await expect(preview).toBeVisible()
    await expect(preview).toContainText('nested')
    await expect(preview.getByRole('link', { name: 'docs' })).toBeVisible()

    // ── Add a timeline update with light markdown ───────────────────────
    const addNote = section.getByTestId('todo-note-add')
    await addNote.fill(UPDATE_BODY)
    await addNote.press('Enter')

    const update = section.getByTestId('todo-note').filter({ hasText: 'Reviewed the PR' })
    await expect(update).toBeVisible()
    const meta = update.getByTestId('todo-note-meta')
    await expect(meta).toBeVisible()
    await expect(meta).toContainText('user')
    // The always-visible note icon now carries the update count.
    await expect(row.getByTestId('todo-notes-count')).toHaveText('1')

    // ── Reload: page + update persist ───────────────────────────────────
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    const reloadedWorktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, reloadedWorktreeId)

    const reloadedRow = orcaPage
      .getByTestId('todo-section-worktree')
      .getByTestId('todo-row')
      .filter({ hasText: TODO_BODY })
    await expect(reloadedRow).toBeVisible({ timeout: 10_000 })
    // Has-content icon + count survive reload.
    await expect(reloadedRow.getByTestId('todo-notes-count')).toHaveText('1')

    await reloadedRow.getByTestId('todo-notes-toggle').click()
    const reloadedSection = orcaPage.getByTestId('todo-section-worktree')
    const reloadedPreview = reloadedSection.getByTestId('todo-notes-doc-preview')
    await expect(reloadedPreview).toBeVisible()
    await expect(reloadedPreview).toContainText('nested')
    await expect(reloadedPreview.getByRole('link', { name: 'docs' })).toBeVisible()
    await expect(
      reloadedSection.getByTestId('todo-note').filter({ hasText: 'Reviewed the PR' })
    ).toBeVisible()
  })
})
