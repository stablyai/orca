import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

test.describe('Worktree notification mute', () => {
  test('toggles per-worktree mute from the context menu', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)

    await worktreeRow(orcaPage, worktreeId).click({ button: 'right' })
    const muteItem = orcaPage.getByRole('menuitem', { name: 'Mute Notifications' })
    await expect(muteItem).toBeVisible()
    await muteItem.click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (id) => window.__store!.getState().notificationsMutedByWorktree[id] === true,
            worktreeId
          ),
        { message: 'mute toggle did not land in the store' }
      )
      .toBe(true)
    await expect(
      worktreeRow(orcaPage, worktreeId).locator('[data-worktree-card-muted-indicator]')
    ).toBeVisible()

    await worktreeRow(orcaPage, worktreeId).click({ button: 'right' })
    const unmuteItem = orcaPage.getByRole('menuitem', { name: 'Unmute Notifications' })
    await expect(unmuteItem).toBeVisible()
    await unmuteItem.click()

    // Why: unmute removes the entry entirely — the default is "not muted", so
    // only opt-ins persist.
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (id) => id in window.__store!.getState().notificationsMutedByWorktree,
            worktreeId
          ),
        { message: 'unmute did not clear the persisted opt-in' }
      )
      .toBe(false)
    await expect(
      worktreeRow(orcaPage, worktreeId).locator('[data-worktree-card-muted-indicator]')
    ).toBeHidden()
  })
})
