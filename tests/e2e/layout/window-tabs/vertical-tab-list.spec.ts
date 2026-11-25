import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

/** Four terminals in the root group, with tabs shown in the left vertical list. */
async function seedVerticalTabs(page: Page): Promise<string> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  return page.evaluate(
    async ({ id }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('window.__store is not available')
      }
      const groupId = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id]?.[0]?.id
      if (!groupId) {
        throw new Error('No root tab group')
      }
      const existing = (state.unifiedTabsByWorktree[id] ?? []).filter(
        (tab) => tab.groupId === groupId
      ).length
      for (let i = existing; i < 4; i++) {
        state.createTab(id, groupId, undefined, { activate: i === 0 })
      }
      await state.updateSettings({ tabStripPosition: 'left' })
      return groupId
    },
    { id: worktreeId }
  )
}

test('Tab position Left shows a keyboard-navigable vertical tab list that collapses and switches back', async ({
  orcaPage
}) => {
  const groupId = await seedVerticalTabs(orcaPage)
  const list = orcaPage.locator(`[data-tab-group-tab-list-id="${groupId}"]`)
  const tablist = list.getByRole('tablist')
  await expect(tablist).toBeVisible()
  await expect(tablist).toHaveAttribute('aria-orientation', 'vertical')
  const tabs = tablist.getByRole('tab')
  await expect(tabs).toHaveCount(4)
  // The top strip no longer draws tabs.
  await expect(orcaPage.locator(`[data-tab-group-strip-id="${groupId}"] [role="tab"]`)).toHaveCount(
    0
  )

  // Arrow keys move focus along the rows; Enter activates the focused row.
  const selected = tablist.locator('[role="tab"][aria-selected="true"]')
  await selected.focus()
  const before = await selected.getAttribute('data-tab-id')
  await orcaPage.keyboard.press('ArrowDown')
  const focusedId = await orcaPage.evaluate(
    () => document.activeElement?.getAttribute('data-tab-id') ?? null
  )
  expect(focusedId).not.toBeNull()
  expect(focusedId).not.toBe(before)
  await orcaPage.keyboard.press('Enter')
  await expect(tablist.locator(`[role="tab"][data-tab-id="${focusedId}"]`)).toHaveAttribute(
    'aria-selected',
    'true'
  )

  // Collapse to icons only; the choice persists in UI state.
  await list.getByRole('button', { name: 'Collapse tab list' }).click()
  await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeLessThan(48)
  await list.getByRole('button', { name: 'Expand tab list' }).click()
  await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeGreaterThan(150)

  // Right-click on the list's empty space switches back to the top strip.
  const box = await tablist.boundingBox()
  if (!box) {
    throw new Error('Tab list has no box')
  }
  await orcaPage.mouse.click(box.x + box.width / 2, box.y + box.height - 8, { button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Show Tabs at the Top' }).click()
  await expect(list).toHaveCount(0)
  await expect(
    orcaPage.locator(`[data-tab-group-strip-id="${groupId}"] [data-tab-strip-slot]`)
  ).toHaveCount(4)
})
