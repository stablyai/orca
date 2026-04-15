/**
 * E2E tests for the "New Worktree" flow in Orca.
 *
 * User Prompt:
 * - create a suite of tests that have the basic user flows for this app. 1. new worktree.
 */

import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree, getActiveWorktreeId, ensureTerminalVisible } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

test.describe('New Worktree', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  /**
   * User Prompt:
   * - new worktree
   */
  test('Cmd/Ctrl+N opens the Create Worktree dialog', async ({ orcaPage }) => {
    // Why: Cmd/Ctrl+N opens the create-worktree modal when at least one git repo exists
    await pressShortcut(orcaPage, 'n')

    // The dialog should appear with the title "New Worktree"
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })
    await expect(dialog.getByText('New Worktree')).toBeVisible()

    // The dialog has a Name input field and Create button
    await expect(dialog.getByPlaceholder('feature/my-feature')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Create' })).toBeVisible()

    // Close the dialog without creating
    await orcaPage.keyboard.press('Escape')
    await expect(dialog).toBeHidden({ timeout: 3_000 })
  })

  /**
   * User Prompt:
   * - new worktree
   */
  test('can create a new worktree and it becomes active', async ({ orcaPage }) => {
    const worktreeIdBefore = await getActiveWorktreeId(orcaPage)

    // Open the create worktree dialog
    await pressShortcut(orcaPage, 'n')
    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // Clear the auto-suggested name and type a test name
    const nameInput = dialog.getByPlaceholder('feature/my-feature')
    await nameInput.waitFor({ state: 'visible' })
    await nameInput.clear()
    const testName = `e2e-test-${Date.now()}`
    await nameInput.fill(testName)

    // Click Create
    const createButton = dialog.getByRole('button', { name: 'Create' })
    await expect(createButton).toBeEnabled()
    await createButton.click()

    // Dialog should close after creation
    await expect(dialog).toBeHidden({ timeout: 30_000 })

    // The new worktree should now be active (different from before)
    await expect
      .poll(async () => {
        const id = await getActiveWorktreeId(orcaPage)
        return id !== null && id !== worktreeIdBefore
      }, { timeout: 10_000, message: 'New worktree did not become active' })
      .toBe(true)

    // A terminal tab should auto-create for the new worktree
    await ensureTerminalVisible(orcaPage)
  })
})
