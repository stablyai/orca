// Regression coverage for active status taking precedence over passive identity (#8813).

import type { Locator, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getAllWorktreeIds,
  ensureTerminalVisible
} from './helpers/store'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

function statusLane(page: Page, worktreeId: string): Locator {
  return worktreeRow(page, worktreeId).locator('[data-worktree-card-status-slot]').first()
}

function statusDot(page: Page, worktreeId: string): Locator {
  return statusLane(page, worktreeId).locator('span.bg-emerald-500').first()
}

function branchIdentityGlyph(page: Page, worktreeId: string): Locator {
  return statusLane(page, worktreeId).locator('svg.lucide-git-branch')
}

// PTY liveness, not the tab row, drives the activity heuristic.
async function waitForLivePty(page: Page, worktreeId: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => {
          const state = window.__store!.getState()
          return (state.tabsByWorktree[id] ?? []).some(
            (tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0
          )
        }, worktreeId),
      { timeout: 30_000, message: `No live PTY attached for worktree ${worktreeId}` }
    )
    .toBe(true)
}

test.describe('Worktree card status indicator', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('paints the emerald Active dot instead of the grey branch glyph once a workspace goes live', async ({
    orcaPage
  }) => {
    const liveWorktreeId = await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForLivePty(orcaPage, liveWorktreeId)

    // The regression requires both the new card style and branch identity.
    await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      await state.updateSettings({ experimentalNewWorktreeCardStyle: true })
      state.setWorktreeCardProperties(['status', 'unread', 'branch'])
    })

    const quietWorktreeId = (await getAllWorktreeIds(orcaPage)).find((id) => id !== liveWorktreeId)
    if (!quietWorktreeId) {
      throw new Error('Seeded repo did not expose a second worktree to keep quiet')
    }

    await expect(branchIdentityGlyph(orcaPage, quietWorktreeId)).toBeVisible()
    await expect(statusLane(orcaPage, quietWorktreeId)).toHaveText('Branch')

    await expect(statusDot(orcaPage, liveWorktreeId)).toBeVisible()
    await expect(statusLane(orcaPage, liveWorktreeId)).toHaveText('Active')
    await expect(branchIdentityGlyph(orcaPage, liveWorktreeId)).toHaveCount(0)

    await worktreeRowSurface(orcaPage, quietWorktreeId).click()
    await expect
      .poll(async () => orcaPage.evaluate(() => window.__store!.getState().activeWorktreeId))
      .toBe(quietWorktreeId)
    await ensureTerminalVisible(orcaPage)
    await waitForLivePty(orcaPage, quietWorktreeId)

    await expect(statusDot(orcaPage, quietWorktreeId)).toBeVisible()
    await expect(statusLane(orcaPage, quietWorktreeId)).toHaveText('Active')
    await expect(branchIdentityGlyph(orcaPage, quietWorktreeId)).toHaveCount(0)
  })
})
