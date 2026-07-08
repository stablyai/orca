import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const WORKTREE_TODO = 'Write the migration guide'
const WORKTREE_TODO_EDITED = 'Write the migration guide (v2)'
const PROJECT_TODO = 'Wire up CI cache'

/**
 * Activate a worktree, open the right sidebar, and switch to the Todos tab by
 * clicking its activity-bar button. Mirrors the store-based setup used by the
 * sibling Checks spec but exercises the real activity-bar item registered for
 * the feature.
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

test.describe('Todos sidebar', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('adds, completes, edits, deletes worktree todos and persists a project todo', async ({
    orcaPage
  }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, worktreeId)

    // ── Worktree scope: add ─────────────────────────────────────────────
    const worktreeSection = orcaPage.getByTestId('todo-section-worktree')
    await expect(worktreeSection).toBeVisible({ timeout: 10_000 })

    const worktreeInput = worktreeSection.getByPlaceholder('Add a todo')
    await worktreeInput.fill(WORKTREE_TODO)
    await worktreeInput.press('Enter')

    const worktreeRow = worktreeSection.getByTestId('todo-row').filter({ hasText: WORKTREE_TODO })
    await expect(worktreeRow).toBeVisible()
    // The input clears after a successful add.
    await expect(worktreeInput).toHaveValue('')

    // ── Toggle complete ─────────────────────────────────────────────────
    const checkbox = worktreeRow.getByRole('checkbox', { name: 'Toggle todo' })
    await checkbox.click()
    await expect(checkbox).toBeChecked()
    // Completed rows are de-emphasized with a line-through on the body.
    await expect(worktreeRow.getByRole('button', { name: WORKTREE_TODO })).toHaveClass(
      /line-through/
    )

    // ── Inline edit ─────────────────────────────────────────────────────
    await worktreeRow.getByRole('button', { name: WORKTREE_TODO }).click()
    // Why: once editing starts the body text becomes an <input> value, so a
    // hasText row filter no longer matches. Scope the edit box through the
    // row's data-testid (the worktree section holds a single row here) instead.
    const editInput = worktreeSection.getByTestId('todo-row').getByRole('textbox')
    await editInput.fill(WORKTREE_TODO_EDITED)
    await editInput.press('Enter')

    const editedRow = worktreeSection
      .getByTestId('todo-row')
      .filter({ hasText: WORKTREE_TODO_EDITED })
    await expect(editedRow).toBeVisible()

    // ── Delete ──────────────────────────────────────────────────────────
    await editedRow.hover()
    await editedRow.getByRole('button', { name: 'Delete todo' }).click()
    await expect(
      worktreeSection.getByTestId('todo-row').filter({ hasText: 'Write the migration guide' })
    ).toHaveCount(0)

    // ── Project scope: add ──────────────────────────────────────────────
    const projectSection = orcaPage.getByTestId('todo-section-project')
    await expect(projectSection).toBeVisible()

    const projectInput = projectSection.getByPlaceholder('Add a todo')
    await projectInput.fill(PROJECT_TODO)
    await projectInput.press('Enter')

    await expect(
      projectSection.getByTestId('todo-row').filter({ hasText: PROJECT_TODO })
    ).toBeVisible()

    // ── Persistence: reload, reopen, the project todo survives ──────────
    await orcaPage.reload({ waitUntil: 'domcontentloaded' })
    await waitForSessionReady(orcaPage)
    const reloadedWorktreeId = await waitForActiveWorktree(orcaPage)
    await openTodos(orcaPage, reloadedWorktreeId)

    await expect(
      orcaPage.getByTestId('todo-section-project').getByTestId('todo-row').filter({
        hasText: PROJECT_TODO
      })
    ).toBeVisible({ timeout: 10_000 })
  })
})
