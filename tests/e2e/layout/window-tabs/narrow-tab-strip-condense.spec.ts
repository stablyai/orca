import type { Page } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady
} from '../../desktop/renderer-probes/store'

/** Six terminals in the left group of a two-column split, with the left sidebar collapsed. */
async function buildNarrowLeftPane(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate((id) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('window.__store is not available')
    }
    state.setSidebarOpen(false)
    state.setRightSidebarOpen(true)
    const leftGroupId = state.activeGroupIdByWorktree[id] ?? state.groupsByWorktree[id]?.[0]?.id
    if (!leftGroupId) {
      throw new Error('No root tab group')
    }
    const existing = (state.unifiedTabsByWorktree[id] ?? []).filter(
      (tab) => tab.groupId === leftGroupId
    ).length
    for (let i = existing; i < 6; i++) {
      state.createTab(id, leftGroupId, undefined, { activate: i === 0 })
    }
    const rightGroupId = state.createEmptySplitGroup(id, leftGroupId, 'right')
    if (!rightGroupId) {
      throw new Error('Right split was not created')
    }
    state.createTab(id, rightGroupId, undefined, { activate: true })
    state.focusGroup(id, leftGroupId)
    return leftGroupId
  }, worktreeId)
}

async function setLeftPaneWidth(page: Page, worktreeId: string, groupId: string, width: number) {
  await page.evaluate(
    ({ id, gid, px }) => {
      const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
      const row = strip?.closest('.workspace-sidebar-seam')?.getBoundingClientRect().width ?? 0
      window.__store?.getState().setTabGroupSplitRatio(id, '', px / row)
    },
    { id: worktreeId, gid: groupId, px: width }
  )
}

/** Where focus sits after a +N pick: the picked slot, this strip's chip, or the picked tab's own content. */
async function pickedFocusTarget(
  page: Page,
  groupId: string,
  slotId: string | null
): Promise<'slot' | 'chip' | 'content' | null> {
  return page.evaluate(
    ({ gid, id }) => {
      const active = document.activeElement
      const strip = document.querySelector(`[data-tab-group-strip-id="${gid}"]`)
      if (!active || !strip) {
        return null
      }
      if (active.closest('[data-tab-strip-slot]')?.getAttribute('data-tab-strip-slot') === id) {
        return 'slot'
      }
      if (strip.contains(active) && active.hasAttribute('data-tab-strip-overflow-chip')) {
        return 'chip'
      }
      // Retained pane content is portaled beside the body, so check its box, not DOM ancestry.
      const body = document
        .querySelector(`[data-tab-group-body-id="${gid}"]`)
        ?.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      const inPane =
        body &&
        !active.closest('[role="menu"]') &&
        rect.left >= body.left - 1 &&
        rect.right <= body.right + 1 &&
        rect.top >= body.top - 1 &&
        rect.bottom <= body.bottom + 1
      return inPane && window.__store?.getState().activeTabId === id ? 'content' : null
    },
    { gid: groupId, id: slotId }
  )
}

test('a narrow left-most pane folds the header, condenses tabs and reaches hidden tabs from +N', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const groupId = await buildNarrowLeftPane(orcaPage, worktreeId)
  const strip = orcaPage.locator(`[data-tab-group-strip-id="${groupId}"]`)

  await setLeftPaneWidth(orcaPage, worktreeId, groupId, 330)
  await expect
    .poll(async () => Math.round((await strip.boundingBox())?.width ?? 0))
    .toBeLessThan(340)

  // The header gives up the "Orca" word and Forward first, so the strip keeps a titled tab and a chip.
  await expect(orcaPage.getByRole('button', { name: 'Go forward' })).toHaveCount(0)
  const chip = strip.locator('[data-tab-strip-overflow-chip]')
  await expect(chip).toBeVisible()
  const rendered = await strip.locator('[data-tab-strip-slot]').count()
  expect(rendered).toBeLessThan(6)
  await expect
    .poll(() =>
      strip
        .locator('.terminal-tab-strip')
        .evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
    .toBe(true)

  // The list holds every tab in strip order; picking a hidden one shows, activates and focuses it.
  await chip.click()
  const rows = orcaPage.locator('[data-tab-strip-list-entry]')
  await expect(rows).toHaveCount(6)
  const lastId = await rows.last().getAttribute('data-tab-strip-list-entry')
  expect(await strip.locator(`[data-tab-strip-slot="${lastId}"]`).count()).toBe(0)
  await rows.last().click()

  const picked = strip.locator(`[data-tab-strip-slot="${lastId}"]`)
  await expect(picked).toBeVisible()
  await expect(picked.locator('[data-active="true"]')).toHaveCount(1)
  // Focus lands on the picked tab: its slot, or its own content when activation focuses it (a terminal).
  await expect.poll(() => pickedFocusTarget(orcaPage, groupId, lastId)).not.toBeNull()
})

test('a chip-only strip keeps a keyboard pick in the pane', async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const groupId = await buildNarrowLeftPane(orcaPage, worktreeId)
  const strip = orcaPage.locator(`[data-tab-group-strip-id="${groupId}"]`)

  await setLeftPaneWidth(orcaPage, worktreeId, groupId, 160)
  const chip = strip.locator('[data-tab-strip-overflow-chip]')
  await expect(chip).toBeVisible()
  // Chip-only: no tab slot is left to focus, so the chip is the fallback target.
  await expect(strip.locator('[data-tab-strip-slot]')).toHaveCount(0)

  await chip.focus()
  await orcaPage.keyboard.press('Enter')
  const rows = orcaPage.locator('[data-tab-strip-list-entry]')
  await expect(rows).toHaveCount(6)
  const lastId = await rows.last().getAttribute('data-tab-strip-list-entry')
  await rows.last().focus()
  await orcaPage.keyboard.press('Enter')

  await expect
    .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
    .toBe(lastId)
  // No slot to land on, so focus goes to the chip, or the picked tab's own content when activation focuses it.
  await expect.poll(() => pickedFocusTarget(orcaPage, groupId, lastId)).not.toBeNull()
})
