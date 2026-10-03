/**
 * Snooze hides a workspace until its wake time; the main process wakes it with
 * no renderer involvement and the row returns unread.
 */

import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

async function prepareSidebar(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store!.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setShowActiveOnly(false)
    state.setFilterRepoIds([])
    state.setShowSleepingWorkspaces(true)
  })
}

async function openRowMenu(page: Page, worktreeId: string, item: RegExp): Promise<void> {
  const menuItem = page.getByRole('menuitem', { name: item })
  await expect(async () => {
    await worktreeRow(page, worktreeId).click({ button: 'right' })
    await expect(menuItem).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 10_000 })
}

test('snooze hides a workspace, the filter peeks it, and wake restores it', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const active = await waitForActiveWorktree(orcaPage)
  const target = (await getAllWorktreeIds(orcaPage)).find((id) => id !== active)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  await prepareSidebar(orcaPage)
  const row = worktreeRow(orcaPage, target)
  await expect(row).toBeVisible()

  await openRowMenu(orcaPage, target, /^Snooze$/)
  await orcaPage.getByRole('menuitem', { name: /^Snooze$/ }).click()
  await orcaPage.getByRole('menuitem', { name: /^1 Hour/ }).click()
  await expect(row).toBeHidden()

  await orcaPage.getByRole('button', { name: /^Workspace options/ }).click()
  const hideSnoozed = orcaPage.getByRole('switch', { name: /Hide snoozed/ })
  await expect(hideSnoozed).toHaveAttribute('aria-checked', 'true')
  await hideSnoozed.click()
  await expect(hideSnoozed).toHaveAttribute('aria-checked', 'false')
  await orcaPage.keyboard.press('Escape')
  await expect(row).toBeVisible()
  await expect(row).toContainText('snoozed')
  await orcaPage.screenshot({ path: testInfo.outputPath('snoozed-peek.png') })

  await openRowMenu(orcaPage, target, /^Wake Now$/)
  await orcaPage.getByRole('menuitem', { name: /^Wake Now$/ }).click()
  await expect(row).not.toContainText('snoozed')
})

test('the main process wakes a snoozed workspace when its time passes', async ({ orcaPage }) => {
  test.setTimeout(90_000)
  await waitForSessionReady(orcaPage)
  const active = await waitForActiveWorktree(orcaPage)
  const target = (await getAllWorktreeIds(orcaPage)).find((id) => id !== active)
  if (!target) {
    throw new Error('Expected a second seeded workspace')
  }
  await prepareSidebar(orcaPage)
  const row = worktreeRow(orcaPage, target)
  await expect(row).toBeVisible()

  // Setup only: the wake under test runs in the main process on its own tick.
  await orcaPage.evaluate(async (id) => {
    const state = window.__store!.getState()
    const result = await state.updateWorktreeMeta(id, {
      isUnread: false,
      snooze: { snoozedAt: Date.now(), wakeAt: Date.now() + 2_000 }
    })
    if (!result.ok) {
      throw new Error(result.error)
    }
  }, target)
  await expect(row).toBeHidden()

  // The wake tick is 30s; allow one full tick plus refresh latency.
  await expect(row).toBeVisible({ timeout: 45_000 })
  await expect(row).not.toContainText('snoozed')
})
