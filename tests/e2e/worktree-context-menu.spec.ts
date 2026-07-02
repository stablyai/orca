import { test, expect } from './helpers/orca-app'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { worktreeRowSurface } from './worktree-row-locators'

const MENU_POSITION_TOLERANCE_PX = 24

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

    const surfaceBox = await surface.boundingBox()
    if (!surfaceBox) {
      throw new Error('Expected worktree row surface to have a bounding box')
    }
    const clickPoint = {
      x: surfaceBox.x + Math.min(40, Math.max(1, surfaceBox.width / 2)),
      y: surfaceBox.y + Math.min(20, Math.max(1, surfaceBox.height / 2))
    }

    await surface.click({
      button: 'right',
      position: { x: clickPoint.x - surfaceBox.x, y: clickPoint.y - surfaceBox.y }
    })

    const menu = orcaPage.getByRole('menu').filter({ hasText: 'Workspace' })
    await expect(menu).toBeVisible()
    const menuBox = await menu.boundingBox()
    if (!menuBox) {
      throw new Error('Expected worktree context menu to have a bounding box')
    }
    expect(Math.abs(menuBox.x - clickPoint.x)).toBeLessThanOrEqual(MENU_POSITION_TOLERANCE_PX)
    expect(Math.abs(menuBox.y - clickPoint.y)).toBeLessThanOrEqual(MENU_POSITION_TOLERANCE_PX)
    await expect(orcaPage.getByRole('menuitem', { name: /^Delete$/ })).toBeVisible()
  })
})
