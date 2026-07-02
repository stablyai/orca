import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

test.describe('Worktree context menu', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('opens delete actions from a right-click on a non-primary worktree', async ({
    orcaPage
  }) => {
    const worktreeId = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return (
        Object.values(state?.worktreesByRepo ?? {})
          .flat()
          .find((worktree) => !worktree.isMainWorktree)?.id ?? null
      )
    })

    if (!worktreeId) {
      throw new Error('Expected the seeded E2E repo to include a non-primary worktree')
    }

    const surface = worktreeRowSurface(orcaPage, worktreeId)
    await surface.scrollIntoViewIfNeeded()
    await expect(surface).toBeVisible()

    await surface.click({ button: 'right' })

    await expect(orcaPage.getByRole('menu').filter({ hasText: 'Workspace' })).toBeVisible()
    await expect(orcaPage.getByRole('menuitem', { name: /^Delete$/ })).toBeVisible()
  })
})
